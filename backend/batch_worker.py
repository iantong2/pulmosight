"""Background worker for a batch of CT scans uploaded together.

One upload can carry several scans (up to 10). Each scan still gets its own job
directory, status.json and result.json — only the *execution* is shared, so the
model server is driven sequentially instead of by one subprocess per scan.

The worker:

1. Classifies each scan in turn and writes its partial result immediately, so
   the results page can rank completed scans while later ones are still running.
2. Runs segmentation for every positive scan right away, so the malignancy
   score used for the ranking is final and no second round of clicks is needed.
3. Marks each positive scan as an individual case in the database, while scans
   the classifier found negative stay in the batch. The results page then shows
   the batch ranking plus any positive scan that was later opened on its own.
4. After the uploaded list is done, sweeps the batch for scans that were never
   started (a previous worker died, or the batch was restarted from the UI) and
   runs them. When nothing is left, the batch is complete.

The worker is idempotent: it resumes from whatever result.json already holds, so
a restart never pays for a classification or segmentation it already did.

Usage (spawned by app.py, not meant to be run by hand):

    python batch_worker.py --units units.json --batch_id <uuid> --classification_api ...
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from config import (
    CLASSIFICATION_API_URL,
    CLASSIFICATION_TIMEOUT_SEC,
    MODEL_API_RETRIES,
    MODEL_API_RETRY_BACKOFF_SEC,
    SEGMENTATION_API_URL,
    SEGMENTATION_TIMEOUT_SEC,
)
from database import (
    fetch_scan_jobs_by_batch,
    save_analysis_result,
)
from run_local_medsam_infer import (
    UPLOAD_DIR,
    _infer_classification_from_api,
    _job_dir_or_raise,
    _render_original_preview,
    _segment_completed_job,
    _write_status_ex,
)
from scoring import SCORE_VERSION, compute_malignancy_score, risk_level

# A lock older than this is assumed to belong to a worker that died with its
# process (a deploy, a machine restart), so a batch can still be restarted. The
# worker touches the lock at every scan, so a live worker never looks stale.
LOCK_MAX_AGE_SEC = 6 * 60 * 60
# The worker accepts one scan at a time and touches the lock as each one starts
# or ends, so a lock this old with no scan reporting "running" means it died.
LOCK_LIVE_SEC = 5 * 60


def batch_state_dir() -> Path:
    """Batch bookkeeping, deliberately outside local_uploads.

    local_uploads is served statically, so a lock, a units file or a worker log
    left in there would be publicly readable. Only the scan assets belong there.
    """
    path = UPLOAD_DIR.parent / "batch_state"
    path.mkdir(parents=True, exist_ok=True)
    return path


def lock_path_for(batch_id: str) -> Path:
    return batch_state_dir() / f"{batch_id}.lock"


def lock_age_sec(batch_id: str) -> float | None:
    try:
        return time.time() - lock_path_for(batch_id).stat().st_mtime
    except OSError:
        return None


def worker_running(batch_id: str) -> bool:
    """True while a live worker holds this batch's lock file."""
    age = lock_age_sec(batch_id)
    return age is not None and age < LOCK_LIVE_SEC


def touch_lock(batch_id: str) -> None:
    """Heartbeat: proves the worker is still alive to the status endpoint."""
    try:
        os.utime(lock_path_for(batch_id), None)
    except OSError:
        pass


def _acquire_lock(batch_id: str) -> bool:
    lock = lock_path_for(batch_id)
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        age = lock_age_sec(batch_id)
        if age is not None and age < LOCK_MAX_AGE_SEC:
            # Recent enough to belong to a worker that is (or just was) alive.
            return False
        # Stale lock: the previous worker never cleaned up. Take it over.
        try:
            lock.unlink()
        except OSError:
            pass
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            return False
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    return True


def release_lock(batch_id: str) -> None:
    try:
        lock_path_for(batch_id).unlink()
    except OSError:
        pass


def spawn_batch_worker(batch_id: str, units: list[dict[str, Any]], root: Path) -> bool:
    """Start the worker for a batch. Returns False when one is already running."""
    if not _acquire_lock(batch_id):
        return False

    units_path = batch_state_dir() / f"{batch_id}.units.json"
    units_path.write_text(json.dumps(units), encoding="utf-8")

    log_path = batch_state_dir() / f"{batch_id}.log"
    subprocess.Popen(
        [
            sys.executable,
            str(root / "batch_worker.py"),
            "--units",
            str(units_path),
            "--batch_id",
            batch_id,
            "--classification_api",
            CLASSIFICATION_API_URL,
            "--segmentation_api",
            SEGMENTATION_API_URL,
            "--classification_timeout",
            str(CLASSIFICATION_TIMEOUT_SEC),
            "--segmentation_timeout",
            str(SEGMENTATION_TIMEOUT_SEC),
            "--retries",
            str(MODEL_API_RETRIES),
            "--retry_backoff",
            str(MODEL_API_RETRY_BACKOFF_SEC),
        ],
        cwd=str(root),
        stdout=open(log_path, "w"),
        stderr=subprocess.STDOUT,
    )
    return True


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _read_status(job_dir: Path) -> dict[str, Any]:
    return _read_json(job_dir / "status.json")


def _write_result(job_dir: Path, payload: dict[str, Any]) -> None:
    (job_dir / "result.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def _has_segmentation(result: dict[str, Any]) -> bool:
    return bool((result.get("segmentation") or {}).get("shape"))


def _persist(job_id: str, has_cancer: bool, score: float, confidence: float) -> None:
    try:
        save_analysis_result(job_id, has_cancer, float(score), float(confidence))
    except Exception as exc:  # pragma: no cover - a DB hiccup must not stop the batch
        print(f"[batch_worker] could not persist analysis for {job_id}: {exc}")


def _ensure_preview(job_dir: Path, job_id: str, input_path: Path) -> str:
    """Render original.png once. A failed render must not fail the scan."""
    try:
        return _render_original_preview(job_dir, job_id, input_path)
    except Exception as preview_err:
        print(f"[batch_worker] preview render failed for {job_id}: {preview_err}")
        if (job_dir / "original.png").exists():
            return f"/api/local_uploads/{job_id}/original.png"
        return ""


def _finish_negative(
    job_dir: Path, job_id: str, input_path: Path, cls_conf: float
) -> None:
    score = compute_malignancy_score(False, cls_conf)
    payload = _read_json(job_dir / "result.json")
    payload.update(
        {
            "malignancyScore": score,
            "confidence": int(round(cls_conf * 100)),
            "riskLevel": risk_level(False, score),
            "scoreVersion": SCORE_VERSION,
            "noduleCount": 0,
            "coordinates": [],
            "findings": [
                "Classification model predicts no cancer evidence on this slice.",
                "Segmentation skipped because classification result is negative.",
                "Clinical review is recommended to confirm findings.",
            ],
            "originalScan": _ensure_preview(job_dir, job_id, input_path),
            "segmentationImages": [],
        }
    )
    _write_result(job_dir, payload)
    _persist(job_id, False, payload["malignancyScore"], payload["confidence"])
    _write_status_ex(job_dir, "completed", stage="completed")


def _finish_positive(
    job_id: str,
    job_dir: Path,
    input_path: Path,
    retries: int,
    retry_backoff: float,
) -> None:
    _write_status_ex(job_dir, "running", stage="segmentation")
    result = _segment_completed_job(
        job_id=job_id,
        input_path=input_path,
        segmentation_api=SEGMENTATION_API_URL,
        segmentation_timeout=SEGMENTATION_TIMEOUT_SEC,
        retries=max(0, retries),
        retry_backoff=max(0.0, retry_backoff),
    )
    if result.get("success"):
        data = result.get("result") or {}
        _persist(
            job_id,
            True,
            float(data.get("malignancyScore") or 0),
            float(data.get("confidence") or 0),
        )


def _classify_scan(
    job_id: str,
    job_dir: Path,
    input_path: Path,
    classification_api: str,
    timeout: float,
    retries: int,
    retry_backoff: float,
) -> None:
    _write_status_ex(job_dir, "running", stage="classification")

    classification_t0 = time.perf_counter()
    cls_payload = _infer_classification_from_api(
        classification_api=classification_api,
        dicom_path=input_path,
        timeout_sec=timeout,
        retries=max(0, retries),
        retry_backoff=max(0.0, retry_backoff),
    )
    classification_time = time.perf_counter() - classification_t0

    has_cancer = bool(cls_payload.get("has_cancer", False))
    cls_conf = float(cls_payload.get("confidence", 0.0))

    # The score exists as soon as classification is done, so it is written now:
    # the ranking can show this scan while the rest of the batch is still running.
    # It already includes the positive floor, so a scan awaiting segmentation
    # never looks less urgent than a confident negative one.
    provisional_score = compute_malignancy_score(has_cancer, cls_conf)
    base_payload: dict[str, Any] = {
        "requestId": job_id,
        "classification": {
            "has_cancer": has_cancer,
            "confidence": cls_conf,
            "processing_time": float(
                cls_payload.get("processing_time", classification_time)
            ),
            "label": cls_payload.get("label"),
            "threshold": cls_payload.get("threshold"),
        },
        "segmentation": None,
        "malignancyScore": provisional_score,
        "confidence": int(round(cls_conf * 100)),
        "riskLevel": risk_level(has_cancer, provisional_score),
        "scoreVersion": SCORE_VERSION,
    }
    _write_result(job_dir, base_payload)
    _persist(
        job_id,
        has_cancer,
        base_payload["malignancyScore"],
        base_payload["confidence"],
    )

    if has_cancer:
        _finish_positive(job_id, job_dir, input_path, retries, retry_backoff)
    else:
        _finish_negative(job_dir, job_id, input_path, cls_conf)


def process_scan(
    unit: dict[str, Any],
    classification_api: str,
    classification_timeout: float,
    retries: int,
    retry_backoff: float,
) -> None:
    job_id = unit["jobId"]
    input_path = Path(unit["scanPath"])
    job_dir = _job_dir_or_raise(job_id)

    try:
        if not input_path.exists():
            raise FileNotFoundError(f"Scan file missing: {input_path}")

        existing = _read_json(job_dir / "result.json")
        classification = existing.get("classification") or {}

        if isinstance(classification.get("has_cancer"), bool):
            # Resuming: classification is the expensive step, never repeat it.
            # Only the step that had not finished is retried.
            if classification["has_cancer"]:
                if not _has_segmentation(existing):
                    _finish_positive(
                        job_id, job_dir, input_path, retries, retry_backoff
                    )
                else:
                    _write_status_ex(job_dir, "completed", stage="completed")
            else:
                _finish_negative(
                    job_dir,
                    job_id,
                    input_path,
                    float(classification.get("confidence", 0.0)),
                )
        else:
            _classify_scan(
                job_id,
                job_dir,
                input_path,
                classification_api=classification_api,
                timeout=classification_timeout,
                retries=retries,
                retry_backoff=retry_backoff,
            )
    except Exception as exc:
        err_msg = f"{type(exc).__name__}: {exc}"
        print(f"[batch_worker] scan failed job_id={job_id}: {err_msg}")
        print(traceback.format_exc())
        _write_status_ex(job_dir, "failed", err_msg, stage="failed")

    # The scan stays attached to its batch even when positive: the batch ranking
    # has to keep showing it. Positive scans are still individual cases in every
    # other view because the analysis page exposes an explicit segmentation
    # action, so nothing here needs to change the database row.
    final_status = _read_status(job_dir).get("status")
    if final_status in (None, "pending"):
        # A scan that never started (worker died before reaching it) must not
        # look like a finished entry in the ranking.
        _write_status_ex(job_dir, "failed", "Scan was not processed.", stage="failed")


def _sweep_batch(batch_id: str, process_kwargs: dict[str, Any]) -> None:
    """Process every scan still attached to the batch, then close it out."""
    for row in fetch_scan_jobs_by_batch(batch_id):
        job_id = row["job_id"]
        job_dir = _job_dir_or_raise(job_id)
        if not job_dir.exists():
            continue

        dcm = next(iter(sorted(job_dir.glob("*.dcm"))), None)
        if dcm is None:
            _write_status_ex(
                job_dir,
                "failed",
                "Scan file missing for this batch entry.",
                stage="failed",
            )
            continue

        # A scan already finished on its own is never re-run by a sweep.
        if _read_status(job_dir).get("status") == "completed":
            continue

        process_scan(
            {
                "jobId": job_id,
                "batchId": batch_id,
                "patientName": row.get("patient_name") or "Unknown",
                "scanPath": str(dcm),
            },
            **process_kwargs,
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--units", required=True)
    parser.add_argument("--batch_id", default="")
    parser.add_argument("--classification_api", required=True)
    parser.add_argument("--segmentation_api", required=True)
    parser.add_argument("--classification_timeout", type=float, default=600.0)
    parser.add_argument("--segmentation_timeout", type=float, default=600.0)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--retry_backoff", type=float, default=0.8)
    args = parser.parse_args()

    units = json.loads(Path(args.units).read_text(encoding="utf-8"))
    process_kwargs = {
        "classification_api": args.classification_api,
        "classification_timeout": args.classification_timeout,
        "retries": args.retries,
        "retry_backoff": args.retry_backoff,
    }

    try:
        for unit in units:
            if args.batch_id:
                touch_lock(args.batch_id)
            process_scan(unit, **process_kwargs)
            if args.batch_id:
                touch_lock(args.batch_id)

        if args.batch_id:
            _sweep_batch(args.batch_id, process_kwargs)
    finally:
        if args.batch_id:
            release_lock(args.batch_id)


if __name__ == "__main__":
    main()
