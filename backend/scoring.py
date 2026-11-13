"""One place that turns a model result into a score and a risk band.

The UI shows a malignancy score next to the classifier's verdict, and the
referral queue and the batch ranking both band that score. When those numbers
were produced in different places they disagreed: a scan the classifier called
malignant could end up with a *lower* score than a benign one (the positive
branch used a nodule-count formula that ignored the classifier confidence),
so the same scan showed "Low risk" in one place and "Moderate" in another.

Rules here, used by the segmented and unsegmented paths alike:

- A positive classification keeps the classifier's confidence as its base, and
  segmentation can only raise it (each candidate nodule region adds a little).
- A negative classification scores its confidence, capped low: the score is
  "how strongly the model believed this", not a cancer probability.
- The risk band follows the classification and the segmentation outcome, never
  the score alone: a flagged scan with at least one segmented lesion is High
  risk; a flagged scan whose segmentation found no lesion is Moderate risk (it
  still needs review, but nothing was localised); a negative scan is Low risk
  however confident the model was. Until segmentation has run, a flagged scan
  stays High risk rather than being assumed clear.
"""

from __future__ import annotations

# Bump when the formula changes. Stored results with an older version are
# recomputed on read, so scans analysed before the change do not keep showing
# the old numbers.
SCORE_VERSION = 3

# Scores are kept inside the band they report, so the gauge ring and the label
# never contradict each other.
HIGH_FLOOR = 70
MODERATE_CEILING = 69
NEGATIVE_CEILING = 49
POSITIVE_FLOOR = 50
NODULE_BONUS = 5
MAX_NODULES_COUNTED = 3


def compute_malignancy_score(
    has_cancer: bool,
    classifier_confidence: float,
    nodule_count: int = 0,
    has_segmentation: bool = False,
) -> int:
    """0-100 score: classifier confidence, nudged up by segmented nodule regions."""
    confidence = max(0.0, min(1.0, float(classifier_confidence or 0.0))) * 100

    if not has_cancer:
        return int(round(min(confidence, NEGATIVE_CEILING)))

    counted = max(0, min(int(nodule_count or 0), MAX_NODULES_COUNTED))

    if has_segmentation and counted == 0:
        # Flagged by the classifier, but segmentation localised nothing: keep it
        # in the Moderate band so it never outranks a scan with a visible lesion.
        return int(round(max(POSITIVE_FLOOR, min(confidence, MODERATE_CEILING))))

    if counted > 0:
        # A localised lesion is the stronger finding, so it stays in the High band
        # even when the classifier itself was not very confident.
        return int(round(max(HIGH_FLOOR, min(confidence + counted * NODULE_BONUS, 99))))

    # Segmentation has not run yet: provisional score, still High risk.
    return int(round(max(POSITIVE_FLOOR, min(confidence, 99))))


def risk_level(
    has_cancer: bool | None,
    score: float | None,
    has_segmentation: bool = False,
    nodule_count: int = 0,
) -> str:
    """Risk band shown by the gauge, the ranking and the referral queue."""
    if has_cancer is True:
        if has_segmentation and int(nodule_count or 0) == 0:
            return "moderate"
        return "high"
    if has_cancer is False:
        return "low"

    # No verdict stored (legacy job): fall back to the score bands.
    if score is None:
        return "low"
    if score >= 70:
        return "high"
    if score >= 30:
        return "moderate"
    return "low"


RISK_LABELS = {
    "high": "High risk",
    "moderate": "Moderate risk",
    "low": "Low risk",
}
