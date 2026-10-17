# ...existing code...
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
import uuid, os, subprocess, sys, json, re
from datetime import datetime
from pathlib import Path
from typing import Any

from config import (
    CLASSIFICATION_API_URL,
    SEGMENTATION_API_URL,
    CLASSIFICATION_TIMEOUT_SEC,
    SEGMENTATION_TIMEOUT_SEC,
    MODEL_API_RETRIES,
    MODEL_API_RETRY_BACKOFF_SEC,
)
from database import (
    accept_referral,
    fetch_analysis_detail,
    fetch_history,
    fetch_referral,
    fetch_referrals,
    initialize_db,
    save_analysis_result,
    upsert_patient,
    upsert_referral,
    upsert_scan_job,
)
from run_local_medsam_infer import app as segmentation_app

load_dotenv()
initialize_db()

app = FastAPI()
app.include_router(segmentation_app.router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://154.85.62.123", "http://pulmosight.top", "https://pulmosight.top", "http://localhost:8080", "http://127.0.0.1:8080", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ROOT = Path(__file__).resolve().parent
UPLOAD_DIR = ROOT / "local_uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

app.mount(
    "/api/local_uploads",
    StaticFiles(directory=str(UPLOAD_DIR)),
    name="local_uploads",
)


def _status_path(job_dir: Path) -> Path:
    return job_dir / "status.json"


_JOB_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _resolve_job_dir(job_id: str) -> Path:
    """Map a job id to its directory, rejecting anything that is not a UUID.

    Job ids arrive from the URL, and on Windows a backslash in the value is a
    directory separator: `..%5Capp.db` used to resolve outside UPLOAD_DIR and
    turn these endpoints into a filesystem oracle. Only ids we generated
    (uuid4) are accepted.
    """
    if not isinstance(job_id, str) or not _JOB_ID_PATTERN.fullmatch(job_id):
        raise HTTPException(status_code=400, detail="Invalid job id")
    return UPLOAD_DIR / job_id


def _result_path(job_dir: Path) -> Path:
    return job_dir / "result.json"


def _write_status(
    job_dir: Path,
    status: str,
    error: str | None = None,
    stage: str | None = None,
    warnings: list[str] | None = None,
):
    payload = {"status": status}
    if error:
        payload["error"] = error
    if stage:
        payload["stage"] = stage
    if warnings:
        payload["warnings"] = warnings
    _status_path(job_dir).write_text(json.dumps(payload), encoding="utf-8")

async def _start_analysis_job(
    ctScan: UploadFile,
    patientId: str,
    patientName: str,
    age: str,
    gender: str,
):
    job_id = str(uuid.uuid4())

    safe_name = Path(ctScan.filename or "upload.bin").name
    # The local inference pipeline only reads single-slice DICOM files. Reject
    # anything else up front so the client gets a clear 400 instead of a job
    # that silently fails in the background.
    if not safe_name.lower().endswith(".dcm"):
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Please upload a DICOM (.dcm) file.",
        )

    job_dir = _resolve_job_dir(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    _write_status(job_dir, "pending", stage="queued")

    scan_path = job_dir / safe_name
    with open(scan_path, "wb") as f:
        f.write(await ctScan.read())

    # Optional: save metadata
    (job_dir / "meta.json").write_text(
        (
            "{"
            f"\"patientId\":\"{patientId}\","
            f"\"patientName\":\"{patientName}\","
            f"\"age\":\"{age}\","
            f"\"gender\":\"{gender}\""
            "}"
        ),
        encoding="utf-8",
    )

    upsert_patient(patientId, patientName, age, gender)
    upsert_scan_job(
        job_id,
        patientId,
        datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S"),
        str(scan_path),
    )

    # Run local inference script (non-blocking)
    subprocess.Popen(
        [
            sys.executable,
            str(ROOT / "run_local_medsam_infer.py"),
            "--input",
            str(scan_path),
            "--classification_api",
            CLASSIFICATION_API_URL,
            "--segmentation_api",
            SEGMENTATION_API_URL,
            "--job_id",
            job_id,
            "--classification_timeout",
            str(CLASSIFICATION_TIMEOUT_SEC),
            "--segmentation_timeout",
            str(SEGMENTATION_TIMEOUT_SEC),
            "--retries",
            str(MODEL_API_RETRIES),
            "--retry_backoff",
            str(MODEL_API_RETRY_BACKOFF_SEC),
        ],
        cwd=str(ROOT),
        stdout=open(job_dir / "subprocess.log", "w"),
        stderr=subprocess.STDOUT,
    )

    return {"jobId": job_id}

@app.post("/api/analysis/start")
async def start_analysis_api(
    ctScan: UploadFile = File(...),
    patientId: str = Form(...),
    patientName: str = Form(...),
    age: str = Form(...),
    gender: str = Form(...),
):
    return await _start_analysis_job(ctScan, patientId, patientName, age, gender)


@app.post("/analysis/start-local")
async def start_local_analysis(
    ctScan: UploadFile = File(...),
    patientId: str = Form(...),
    patientName: str = Form(...),
    age: str = Form(...),
    gender: str = Form(...),
):
    return await _start_analysis_job(ctScan, patientId, patientName, age, gender)


@app.get("/api/analysis/status/{job_id}")
async def analysis_status(job_id: str):
    job_dir = _resolve_job_dir(job_id)
    if not job_dir.exists():
        raise HTTPException(status_code=404, detail="Job not found")

    st_path = _status_path(job_dir)
    if not st_path.exists():
        return {"status": "pending"}

    try:
        return json.loads(st_path.read_text(encoding="utf-8"))
    except Exception:
        return {"status": "pending"}


# ...existing code...
@app.get("/api/analysis/result/{job_id}")
async def analysis_result(job_id: str):
    job_dir = _resolve_job_dir(job_id)
    if not job_dir.exists():
        raise HTTPException(status_code=404, detail="Job not found")

    st_path = _status_path(job_dir)
    if st_path.exists():
        try:
            st = json.loads(st_path.read_text(encoding="utf-8"))
        except Exception:
            st = {"status": "pending"}
    else:
        st = {"status": "pending"}

    status = st.get("status", "pending")
    if status != "completed":
        payload = {"status": status, "stage": st.get("stage", "queued")}
        if "error" in st:
            payload["error"] = st.get("error")
        if "warnings" in st:
            payload["warnings"] = st.get("warnings")
        res_path = _result_path(job_dir)
        if res_path.exists():
            try:
                partial = json.loads(res_path.read_text(encoding="utf-8"))
                payload.update(partial)
            except Exception:
                pass
        return payload

    res_path = _result_path(job_dir)
    if not res_path.exists():
        return {"status": "running"}

    try:
        data = json.loads(res_path.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Corrupted result.json: {e}")

    data["status"] = "completed"
    data["stage"] = st.get("stage", "completed")
    if "warnings" in st:
        data["warnings"] = st.get("warnings")

    if "requestId" not in data:
        data["requestId"] = job_id

    # Persist the job result into SQLite so it can be displayed by the history UI.
    classification = data.get("classification") or {}
    is_cancer = bool(classification.get("has_cancer", False))
    malignancy_score = data.get("malignancyScore")
    confidence = data.get("confidence")

    try:
        meta = {}
        meta_path = job_dir / "meta.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}

        patient_id = meta.get("patientId")
        patient_name = meta.get("patientName") or "Unknown"
        age = meta.get("age")
        gender = meta.get("gender")
        if patient_id:
            upsert_patient(patient_id, patient_name, age, gender)
            upsert_scan_job(
                job_id,
                patient_id,
                datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S"),
                str(next(iter(sorted(job_dir.glob("*.dcm"))), "")) or None,
            )

        save_analysis_result(job_id, is_cancer, malignancy_score, confidence)
    except Exception:
        pass

    print(f"[api] /api/analysis/result completed job_id={job_id}")
    print(f"[api] result.json path: {res_path}")
    print("[api] result payload:\n" + json.dumps(data, indent=2, ensure_ascii=False))

    return data


@app.get("/api/history")
async def history_api():
    """Return a joined view of patient + scan + analysis data for the history dashboard."""
    rows = fetch_history()
    payload = []
    for row in rows:
        payload.append(
            {
                "jobId": row.get("job_id"),
                "patientId": row.get("patient_id"),
                "patientName": row.get("patient_name") or "Unknown",
                "scanDate": row.get("scan_date"),
                "malignancyScore": row.get("malignancy_score"),
                "isCancer": bool(row.get("is_cancer")),
                "confidence": row.get("confidence"),
            }
        )
    return payload


_DEFAULT_ASSIGNED_SERVICE = "Respiratory Medicine"


def _risk_level_for_score(score: float | None) -> str:
    """Same bands the UI gauge uses, so the queue and the analysis agree."""
    if score is None:
        return "low"
    if score >= 70:
        return "high"
    if score >= 30:
        return "moderate"
    return "low"


def _read_job_json(job_dir: Path, name: str) -> dict[str, Any]:
    path = job_dir / name
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _referral_payload(row: dict[str, Any]) -> dict[str, Any]:
    job_id = row.get("job_id")
    job_dir = UPLOAD_DIR / job_id if job_id else None
    result_data = _read_job_json(job_dir, "result.json") if job_dir else {}
    meta = _read_job_json(job_dir, "meta.json") if job_dir else {}
    classification = result_data.get("classification") or {}

    # The Analysis page reads /api/analysis/{job_id}, which does not persist.
    # Fall back to the job files so a referral still carries the patient's age,
    # gender and true classification even when no DB row was written yet.
    age = row.get("age")
    if age is None:
        age = meta.get("age")
    gender = row.get("gender")
    if gender is None:
        gender = meta.get("gender")

    has_cancer = classification.get("has_cancer")
    is_cancer = (
        bool(has_cancer) if isinstance(has_cancer, bool) else bool(row.get("is_cancer"))
    )

    score = row.get("malignancy_score")
    if score is None:
        score = result_data.get("malignancyScore")

    return {
        "jobId": job_id,
        "patientId": row.get("patient_id") or meta.get("patientId"),
        "patientName": row.get("patient_name") or meta.get("patientName") or "Unknown",
        "age": age,
        "gender": gender,
        "riskLevel": row.get("risk_level") or "low",
        "malignancyScore": score,
        "isCancer": is_cancer,
        "confidence": row.get("confidence"),
        "reason": row.get("reason") or "",
        "assignedService": row.get("assigned_service") or _DEFAULT_ASSIGNED_SERVICE,
        "status": row.get("status") or "pending",
        "referredAt": row.get("referred_at"),
        "acceptedAt": row.get("accepted_at"),
        "originalScan": result_data.get("originalScan") or "",
    }


@app.post("/api/referrals")
async def create_referral_api(payload: dict):
    """Confirm an analysis and place the case in the physician referral queue.

    Called by the "Confirm and refer to corresponding physicians" action. The
    risk band is derived from the stored malignancy score so the queue order
    cannot drift from what the analysis page showed.
    """
    job_id = payload.get("jobId") or payload.get("job_id")
    if not job_id:
        raise HTTPException(status_code=400, detail="jobId is required")

    job_dir = _resolve_job_dir(job_id)
    if not job_dir.exists():
        raise HTTPException(status_code=404, detail="Job not found")

    result_data = _read_job_json(job_dir, "result.json")
    meta = _read_job_json(job_dir, "meta.json")
    detail = fetch_analysis_detail(job_id) or {}

    score = result_data.get("malignancyScore")
    if score is None:
        score = detail.get("malignancy_score")
    if score is None:
        classification = result_data.get("classification") or {}
        score = round(float(classification.get("confidence", 0.0)) * 100, 2)

    patient_id = detail.get("patient_id") or meta.get("patientId") or ""
    patient_name = (
        detail.get("patient_name") or meta.get("patientName") or "Unknown"
    )
    is_cancer = bool(
        (result_data.get("classification") or {}).get("has_cancer", False)
    )

    # The Analysis page loads /api/analysis/{job_id}, which does not write to
    # SQLite. Persist the case here so the queue, history and detail views all
    # describe the same analysis.
    if patient_id and detail.get("job_id") is None:
        upsert_patient(
            patient_id,
            patient_name,
            meta.get("age"),
            meta.get("gender"),
        )
        scan_file = next(iter(sorted(job_dir.glob("*.dcm"))), None)
        upsert_scan_job(
            job_id,
            patient_id,
            datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S"),
            str(scan_file) if scan_file else None,
        )
        save_analysis_result(
            job_id,
            is_cancer,
            float(score) if score is not None else None,
            result_data.get("confidence"),
        )

    default_reason = (
        "Suspicious lung nodule: radiology confirmed, awaiting physician review."
        if is_cancer
        else "Classification result flagged for physician review."
    )

    upsert_referral(
        job_id=job_id,
        patient_id=patient_id,
        patient_name=patient_name,
        risk_level=_risk_level_for_score(
            float(score) if score is not None else None
        ),
        malignancy_score=float(score) if score is not None else None,
        reason=payload.get("reason") or default_reason,
        assigned_service=payload.get("assignedService") or _DEFAULT_ASSIGNED_SERVICE,
    )

    row = fetch_referral(job_id)
    if row is None:  # pragma: no cover - only if the insert failed silently
        raise HTTPException(status_code=500, detail="Could not create referral")
    return _referral_payload(row)


@app.get("/api/referrals")
async def list_referrals_api():
    """Referral queue for the physician portal, highest risk first."""
    return [_referral_payload(row) for row in fetch_referrals()]


@app.get("/api/referrals/{job_id}")
async def referral_detail_api(job_id: str):
    _resolve_job_dir(job_id)
    row = fetch_referral(job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Referral not found")
    return _referral_payload(row)


@app.post("/api/referrals/{job_id}/accept")
async def accept_referral_api(job_id: str):
    _resolve_job_dir(job_id)
    if fetch_referral(job_id) is None:
        raise HTTPException(status_code=404, detail="Referral not found")

    accept_referral(job_id)
    row = fetch_referral(job_id)
    if row is None:  # pragma: no cover - row cannot vanish between statements
        raise HTTPException(status_code=404, detail="Referral not found")
    return _referral_payload(row)


@app.get("/api/analysis/{job_id}")
async def analysis_detail_api(job_id: str):
    """Return the persisted result for a single job, suitable for the detail page route."""
    job_dir = _resolve_job_dir(job_id)
    result_path = _result_path(job_dir) if job_dir.exists() else None
    result_data: dict[str, Any] = {}

    if result_path and result_path.exists():
        try:
            result_data = json.loads(result_path.read_text(encoding="utf-8"))
        except Exception:
            result_data = {}

    item = fetch_analysis_detail(job_id)
    if item is None and not result_data:
        if not job_dir.exists():
            raise HTTPException(status_code=404, detail="Job not found")
        if not result_path or not result_path.exists():
            raise HTTPException(status_code=404, detail="Analysis result not found")

    meta = {}
    if job_dir.exists():
        meta_path = job_dir / "meta.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}

    # Report the job's real state. This endpoint used to hardcode "completed",
    # which made failed or still-running analyses look finished in the UI.
    status_payload: dict[str, Any] = {}
    if job_dir.exists():
        st_path = _status_path(job_dir)
        if st_path.exists():
            try:
                status_payload = json.loads(st_path.read_text(encoding="utf-8"))
            except Exception:
                status_payload = {}

    has_result = bool(result_data) or item is not None
    status = status_payload.get("status") or ("completed" if has_result else "pending")
    stage = status_payload.get("stage") or (
        "completed" if status == "completed" else "queued"
    )
    error_message = status_payload.get("error")

    classification_payload = result_data.get("classification")
    if item is not None and classification_payload is None:
        if item.get("is_cancer") is not None or item.get("confidence") is not None:
            classification_payload = {
                "has_cancer": bool(item.get("is_cancer")),
                "confidence": float(item.get("confidence") or 0),
            }

    if item is None:
        return {
            "jobId": job_id,
            "patientId": meta.get("patientId"),
            "patientName": meta.get("patientName") or "Unknown",
            "age": meta.get("age"),
            "gender": meta.get("gender"),
            "scanDate": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S"),
            "imagePath": str(next(iter(sorted(job_dir.glob("*.dcm"))), "")) or None if job_dir.exists() and any(job_dir.glob("*.dcm")) else None,
            "classification": classification_payload,
            "segmentation": result_data.get("segmentation"),
            "malignancyScore": result_data.get("malignancyScore"),
            "confidence": result_data.get("confidence"),
            "noduleCount": result_data.get("noduleCount"),
            "coordinates": result_data.get("coordinates") or [],
            "findings": result_data.get("findings") or [],
            "originalScan": result_data.get("originalScan") or "",
            "segmentationImages": result_data.get("segmentationImages") or [],
            "status": status,
            "stage": stage,
            **({"error": error_message} if error_message else {}),
        }

    return {
        "jobId": item.get("job_id"),
        "patientId": item.get("patient_id"),
        "patientName": item.get("patient_name") or meta.get("patientName") or "Unknown",
        "age": item.get("age") if item.get("age") is not None else meta.get("age"),
        "gender": item.get("gender") if item.get("gender") is not None else meta.get("gender"),
        "scanDate": item.get("scan_date") or datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S"),
        "imagePath": item.get("image_path"),
        "classification": classification_payload,
        "segmentation": result_data.get("segmentation"),
        "malignancyScore": result_data.get("malignancyScore", item.get("malignancy_score")),
        "confidence": result_data.get("confidence", item.get("confidence")),
        "noduleCount": result_data.get("noduleCount", 0),
        "coordinates": result_data.get("coordinates") or [],
        "findings": result_data.get("findings") or [],
        "originalScan": result_data.get("originalScan") or "",
        "segmentationImages": result_data.get("segmentationImages") or [],
        "status": status,
        "stage": stage,
        **({"error": error_message} if error_message else {}),
    }


@app.post("/api/analysis")
async def save_analysis_api(payload: dict):
    """Persist a completed analysis result. This is used by the history screen and detail page."""
    job_id = payload.get("jobId") or payload.get("job_id")
    if not job_id:
        raise HTTPException(status_code=400, detail="jobId is required")

    patient = payload.get("patient") or {}
    patient_id = patient.get("id") or patient.get("patientId")
    patient_name = patient.get("name") or patient.get("patientName") or "Unknown"
    age = patient.get("age")
    gender = patient.get("gender")
    if patient_id:
        upsert_patient(patient_id, patient_name, age, gender)

    scan_date = payload.get("scanDate") or payload.get("scan_date") or datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")
    image_path = payload.get("imagePath") or payload.get("image_path")
    if patient_id:
        upsert_scan_job(job_id, patient_id, scan_date, image_path)

    classification = payload.get("classification") or {}
    is_cancer = bool(classification.get("has_cancer", False))
    malignancy_score = payload.get("malignancyScore")
    confidence = payload.get("confidence")
    save_analysis_result(job_id, is_cancer, malignancy_score, confidence)
    return {"success": True, "jobId": job_id}
# ...existing code...