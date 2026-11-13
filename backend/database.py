from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent / "app.db"
UPLOAD_DIR = Path(__file__).resolve().parent / "local_uploads"


def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def initialize_db() -> None:
    """Create the SQLite tables used by the historical history dashboard."""
    conn = get_db_connection()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS patients (
                patient_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                age INTEGER,
                gender TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scan_jobs (
                job_id TEXT PRIMARY KEY,
                patient_id TEXT NOT NULL,
                scan_date TEXT NOT NULL,
                image_path TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (patient_id) REFERENCES patients(patient_id)
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS analysis_results (
                job_id TEXT PRIMARY KEY,
                is_cancer INTEGER NOT NULL DEFAULT 0,
                malignancy_score REAL,
                confidence REAL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (job_id) REFERENCES scan_jobs(job_id)
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS referrals (
                job_id TEXT PRIMARY KEY,
                patient_id TEXT NOT NULL,
                patient_name TEXT NOT NULL,
                risk_level TEXT NOT NULL DEFAULT 'low',
                malignancy_score REAL,
                reason TEXT,
                assigned_service TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                referred_at TEXT DEFAULT CURRENT_TIMESTAMP,
                accepted_at TEXT,
                FOREIGN KEY (job_id) REFERENCES scan_jobs(job_id)
            )
            """
        )

        # A case the radiologist marks as "require human analysis" is taken out
        # of the physician referral queue and waits for a human read instead.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS human_reviews (
                job_id TEXT PRIMARY KEY,
                requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (job_id) REFERENCES scan_jobs(job_id)
            )
            """
        )

        # A batch is one upload of up to 10 scans. Scans uploaded together share
        # a batch_id so the results page can rank them against each other. The
        # column is added by migration because scan_jobs already exists in the
        # deployed database.
        scan_job_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(scan_jobs)")
        }
        if "batch_id" not in scan_job_columns:
            conn.execute("ALTER TABLE scan_jobs ADD COLUMN batch_id TEXT")

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scan_jobs_patient ON scan_jobs(patient_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scan_jobs_batch ON scan_jobs(batch_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_analysis_results_job ON analysis_results(job_id)"
        )
        conn.commit()
    finally:
        conn.close()


def upsert_patient(patient_id: str, name: str, age: int | str | None, gender: str | None) -> None:
    # `str(None)` is the truthy string "None", so a missing age used to reach
    # int(None) and raise. Normalise the missing cases to NULL up front.
    normalized_age = None
    if age is not None and str(age).strip():
        try:
            normalized_age = int(float(str(age).strip()))
        except ValueError:
            normalized_age = None

    conn = get_db_connection()
    try:
        conn.execute(
            """
            INSERT INTO patients (patient_id, name, age, gender)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(patient_id)
            DO UPDATE SET name = excluded.name, age = excluded.age, gender = excluded.gender
            """,
            (patient_id, name, normalized_age, gender),
        )
        conn.commit()
    finally:
        conn.close()


def upsert_scan_job(
    job_id: str,
    patient_id: str,
    scan_date: str,
    image_path: str | None = None,
    batch_id: str | None = None,
) -> None:
    conn = get_db_connection()
    try:
        conn.execute(
            """
            INSERT INTO scan_jobs (job_id, patient_id, scan_date, image_path, batch_id)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(job_id)
            DO UPDATE SET patient_id = excluded.patient_id,
                         scan_date = excluded.scan_date,
                         image_path = excluded.image_path,
                         batch_id = COALESCE(excluded.batch_id, scan_jobs.batch_id)
            """,
            (job_id, patient_id, scan_date, image_path, batch_id),
        )
        conn.commit()
    finally:
        conn.close()


def save_analysis_result(
    job_id: str,
    is_cancer: bool,
    malignancy_score: float | None,
    confidence: float | None,
) -> None:
    conn = get_db_connection()
    try:
        conn.execute(
            """
            INSERT INTO analysis_results (job_id, is_cancer, malignancy_score, confidence)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(job_id)
            DO UPDATE SET is_cancer = excluded.is_cancer,
                          malignancy_score = excluded.malignancy_score,
                          confidence = excluded.confidence,
                          created_at = CURRENT_TIMESTAMP
            """,
            (job_id, 1 if is_cancer else 0, malignancy_score, confidence),
        )
        conn.commit()
    finally:
        conn.close()


def fetch_history() -> list[dict[str, Any]]:
    conn = get_db_connection()
    try:
        rows = conn.execute(
            """
            SELECT
                sj.job_id,
                sj.patient_id,
                p.name AS patient_name,
                p.age,
                p.gender,
                sj.scan_date,
                sj.image_path,
                ar.is_cancer,
                ar.malignancy_score,
                ar.confidence
            FROM scan_jobs sj
            LEFT JOIN patients p ON p.patient_id = sj.patient_id
            LEFT JOIN analysis_results ar ON ar.job_id = sj.job_id
            ORDER BY datetime(sj.scan_date) DESC
            """
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def fetch_analysis_detail(job_id: str) -> dict[str, Any] | None:
    conn = get_db_connection()
    try:
        row = conn.execute(
            """
            SELECT
                sj.job_id,
                sj.patient_id,
                p.name AS patient_name,
                p.age,
                p.gender,
                sj.scan_date,
                sj.image_path,
                sj.batch_id,
                ar.is_cancer,
                ar.malignancy_score,
                ar.confidence
            FROM scan_jobs sj
            LEFT JOIN patients p ON p.patient_id = sj.patient_id
            LEFT JOIN analysis_results ar ON ar.job_id = sj.job_id
            WHERE sj.job_id = ?
            """,
            (job_id,),
        ).fetchone()
        return dict(row) if row is not None else None
    finally:
        conn.close()


def fetch_scan_jobs_by_batch(batch_id: str) -> list[dict[str, Any]]:
    """Every scan in a batch, with its patient and stored analysis result."""
    conn = get_db_connection()
    try:
        rows = conn.execute(
            """
            SELECT
                sj.job_id,
                sj.patient_id,
                p.name AS patient_name,
                sj.scan_date,
                sj.image_path,
                sj.batch_id,
                ar.is_cancer,
                ar.malignancy_score,
                ar.confidence
            FROM scan_jobs sj
            LEFT JOIN patients p ON p.patient_id = sj.patient_id
            LEFT JOIN analysis_results ar ON ar.job_id = sj.job_id
            WHERE sj.batch_id = ?
            ORDER BY datetime(sj.scan_date) ASC, sj.job_id ASC
            """,
            (batch_id,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


_REFERRAL_SELECT = """
    SELECT
        r.job_id,
        r.patient_id,
        r.patient_name,
        r.risk_level,
        r.malignancy_score,
        r.reason,
        r.assigned_service,
        r.status,
        r.referred_at,
        r.accepted_at,
        p.age,
        p.gender,
        ar.is_cancer,
        ar.confidence
    FROM referrals r
    LEFT JOIN patients p ON p.patient_id = r.patient_id
    LEFT JOIN analysis_results ar ON ar.job_id = r.job_id
"""

# High risk first, then moderate, then low. Within a risk band the highest
# malignancy score is reviewed first, so the case the analysis page ranked top
# is also the case at the top of this queue.
_REFERRAL_ORDER = """
    ORDER BY
        CASE r.risk_level WHEN 'high' THEN 0 WHEN 'moderate' THEN 1 ELSE 2 END,
        COALESCE(r.malignancy_score, -1) DESC,
        datetime(r.referred_at) ASC
"""


def upsert_referral(
    job_id: str,
    patient_id: str,
    patient_name: str,
    risk_level: str,
    malignancy_score: float | None,
    reason: str | None,
    assigned_service: str | None,
) -> None:
    """Create (or refresh) the referral for a job.

    The confirm button can be pressed twice (double click, retry after a slow
    response), so the job id is the primary key. Re-confirming keeps the original
    status, referral time and acceptance time, but the risk band and score are
    updated: a case scored before the scoring rules changed must not stay in the
    wrong band (a malignant scan used to be stored as "low").
    """
    conn = get_db_connection()
    try:
        conn.execute(
            """
            INSERT INTO referrals (
                job_id, patient_id, patient_name, risk_level,
                malignancy_score, reason, assigned_service
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_id) DO UPDATE SET
                patient_id = excluded.patient_id,
                patient_name = excluded.patient_name,
                risk_level = excluded.risk_level,
                malignancy_score = excluded.malignancy_score,
                reason = COALESCE(referrals.reason, excluded.reason),
                assigned_service = COALESCE(
                    referrals.assigned_service, excluded.assigned_service
                )
            """,
            (
                job_id,
                patient_id,
                patient_name,
                risk_level,
                malignancy_score,
                reason,
                assigned_service,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def fetch_referrals() -> list[dict[str, Any]]:
    conn = get_db_connection()
    try:
        rows = conn.execute(f"{_REFERRAL_SELECT} {_REFERRAL_ORDER}").fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def fetch_referral(job_id: str) -> dict[str, Any] | None:
    conn = get_db_connection()
    try:
        row = conn.execute(
            f"{_REFERRAL_SELECT} WHERE r.job_id = ?",
            (job_id,),
        ).fetchone()
        return dict(row) if row is not None else None
    finally:
        conn.close()


def accept_referral(job_id: str) -> int:
    """Mark a referral as accepted. Returns the number of rows changed."""
    conn = get_db_connection()
    try:
        cursor = conn.execute(
            """
            UPDATE referrals
            SET status = 'accepted',
                accepted_at = CURRENT_TIMESTAMP
            WHERE job_id = ?
            """,
            (job_id,),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def _job_keys(job_id: str) -> list[str]:
    """Every job id that identifies the same patient across re-uploads.

    Every upload creates a new job id, so the same DICOM uploaded twice becomes
    two rows naming the same patient. A human-read request must cover both, or
    the older copy stays in the physician queue — which is exactly what went
    wrong: the queue offered "1-009" while the request had been made on a later
    upload of that same scan.

    The file's content hash is the reliable identity. When the hash is missing
    (an upload written before hashing existed), fall back to the patient name and
    the scan file name, which is what the upload records.
    """
    conn = get_db_connection()
    try:
        row = conn.execute(
            "SELECT patient_id, image_path FROM scan_jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()
        keys = [job_id]
        if row is None:
            return keys

        meta = {}
        meta_path = Path(row["image_path"] or "").parent / "meta.json"
        try:
            if meta_path.exists():
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            meta = {}

        scan_hash = meta.get("scanHash")
        if scan_hash:
            matched = conn.execute(
                """
                SELECT sj.job_id FROM scan_jobs sj
                JOIN patients p ON p.patient_id = sj.patient_id
                WHERE sj.image_path = ? OR p.patient_id = ?
                """,
                (row["image_path"], row["patient_id"]),
            ).fetchall()
            hash_matches = [
                r["job_id"]
                for r in matched
                if _read_meta(r["job_id"]).get("scanHash") == scan_hash
            ]
            keys.extend(hash_matches)
        else:
            patient_name = meta.get("patientName")
            file_name = meta.get("fileName")
            if patient_name:
                rows = conn.execute(
                    """
                    SELECT sj.job_id, sj.image_path FROM scan_jobs sj
                    JOIN patients p ON p.patient_id = sj.patient_id
                    WHERE p.name = ?
                    """,
                    (patient_name,),
                ).fetchall()
                for other in rows:
                    other_meta = _read_meta(other["job_id"])
                    if other_meta.get("patientName") != patient_name:
                        continue
                    if file_name and other_meta.get("fileName") not in (None, file_name):
                        continue
                    keys.append(other["job_id"])

        return sorted(set(keys))
    finally:
        conn.close()


def _read_meta(job_id: str) -> dict[str, Any]:
    for base in (UPLOAD_DIR,):
        path = base / job_id / "meta.json"
        try:
            if path.exists():
                return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
    return {}


def request_human_review(job_id: str) -> list[str]:
    """Flag a case for a human read and take every copy of it out of the queue.

    Returns the job ids that were flagged, including older uploads of the same
    scan, so the API can report what actually changed.
    """
    keys = _job_keys(job_id)
    conn = get_db_connection()
    try:
        for key in keys:
            conn.execute(
                """
                INSERT INTO human_reviews (job_id) VALUES (?)
                ON CONFLICT(job_id) DO NOTHING
                """,
                (key,),
            )
            # The queue is "cases a physician has not looked at yet"; a
            # human-read request means the case no longer belongs there.
            conn.execute("DELETE FROM referrals WHERE job_id = ?", (key,))
        conn.commit()
        return keys
    finally:
        conn.close()


def fetch_human_review(job_id: str) -> dict[str, Any] | None:
    """Human-read state for a job, including older uploads of the same scan."""
    keys = _job_keys(job_id)
    conn = get_db_connection()
    try:
        row = conn.execute(
            f"""
            SELECT job_id, requested_at FROM human_reviews
            WHERE job_id IN ({",".join("?" for _ in keys)})
            ORDER BY datetime(requested_at) DESC
            LIMIT 1
            """,
            tuple(keys),
        ).fetchone()
        return dict(row) if row is not None else None
    finally:
        conn.close()


def exclude_human_reviewed(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop queue rows whose case was flagged for a human read on any upload."""
    if not rows:
        return rows
    conn = get_db_connection()
    try:
        flagged = {r["job_id"] for r in conn.execute("SELECT job_id FROM human_reviews")}
    finally:
        conn.close()

    if not flagged:
        return rows

    kept = []
    for row in rows:
        keys = _job_keys(row["job_id"])
        if any(key in flagged for key in keys):
            continue
        kept.append(row)
    return kept


if __name__ == "__main__":
    initialize_db()
    print(f"SQLite database initialized at: {DB_PATH}")
