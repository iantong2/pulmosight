import { apiUrl } from "@/lib/api";
import { BatchScan, RiskLevel } from "@/types/batch";

/**
 * Single source of truth for a scan's risk band.
 *
 * The backend computes it and sends it as `riskLevel`; this fallback only runs
 * for an older response. It mirrors the backend rules: a flagged scan with a
 * segmented lesion is High risk, a flagged scan whose segmentation found nothing
 * is Moderate risk, and a scan the classifier did not flag is Low risk.
 */
export const scanRiskLevel = (scan: BatchScan): RiskLevel => {
  if (scan.riskLevel) return scan.riskLevel;
  if (scan.hasCancer === false) return "low";
  if (scan.hasCancer === true) {
    const segmented = (scan.segmentationImages?.length ?? 0) > 0;
    if (segmented) return (scan.noduleCount ?? 0) > 0 ? "high" : "moderate";
    return "high";
  }

  const score = scan.malignancyScore ?? 0;
  if (score >= 70) return "high";
  if (score >= 30) return "moderate";
  return "low";
};

export const RISK_LABELS: Record<RiskLevel, string> = {
  high: "High risk",
  moderate: "Moderate risk",
  low: "Low risk",
};

/** Tailwind classes for a risk badge, shared by the ranking and the detail panel. */
export const RISK_BADGES: Record<RiskLevel, string> = {
  high: "bg-destructive/15 text-destructive border-destructive/40",
  moderate: "bg-warning/15 text-warning border-warning/40",
  low: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40",
};

/**
 * Ranking order for a batch: highest malignancy score first.
 *
 * The score already encodes the clinical order — a flagged scan with a segmented
 * lesion sits in the 70s and above, a flagged scan whose segmentation found
 * nothing in the 50-69 band, and a negative scan below that — so ranking on the
 * score alone matches the risk bands. Scans still running or failed have no
 * score yet and follow the finished ones in upload order, so the list never
 * reshuffles under the reader's cursor.
 */
export const rankScans = (scans: BatchScan[]): BatchScan[] => {
  return [...scans].sort((a, b) => {
    const aDone = a.status === "completed";
    const bDone = b.status === "completed";
    if (aDone !== bDone) return aDone ? -1 : 1;

    if (aDone && bDone) {
      const aScore = a.malignancyScore ?? -1;
      const bScore = b.malignancyScore ?? -1;
      if (aScore !== bScore) return bScore - aScore;
    }

    return 0;
  });
};

/** Fire the manual segmentation endpoint for a single scan. */
export const startSegmentation = async (jobId: string): Promise<void> => {
  const response = await fetch(apiUrl("/api/segmentation/run"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, requestId: jobId, analysisId: jobId }),
  });

  const raw = await response.text().catch(() => "");
  let data: { success?: boolean; error?: string; status?: string } = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }

  if (!response.ok || data.success === false) {
    throw new Error(
      data.error || `Segmentation could not be started. (HTTP ${response.status})`,
    );
  }
};
