from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent / "app.db"


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

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scan_jobs_patient ON scan_jobs(patient_id)"
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


def upsert_scan_job(job_id: str, patient_id: str, scan_date: str, image_path: str | None = None) -> None:
    conn = get_db_connection()
    try:
        conn.execute(
            """
            INSERT INTO scan_jobs (job_id, patient_id, scan_date, image_path)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(job_id)
            DO UPDATE SET patient_id = excluded.patient_id,
                         scan_date = excluded.scan_date,
                         image_path = excluded.image_path
            """,
            (job_id, patient_id, scan_date, image_path),
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

# High risk first, then moderate, then low. Within a risk band the oldest
# referral is reviewed first, which is what "high-risk cases are prioritised
# for earlier review" means for the clinician working the queue.
_REFERRAL_ORDER = """
    ORDER BY
        CASE r.risk_level WHEN 'high' THEN 0 WHEN 'moderate' THEN 1 ELSE 2 END,
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
    """Create the referral for a job. Re-confirming an existing referral is a no-op.

    The confirm button can be pressed twice (double click, retry after a slow
    response), so the job id is the primary key and an existing row keeps its
    original status and timestamp.
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
            ON CONFLICT(job_id) DO NOTHING
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


if __name__ == "__main__":
    initialize_db()
    print(f"SQLite database initialized at: {DB_PATH}")
