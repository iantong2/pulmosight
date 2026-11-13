import { cn } from "@/lib/utils";
import {
  RISK_BADGES,
  RISK_LABELS,
  rankScans,
  scanRiskLevel,
} from "@/lib/batch";
import { BatchScan } from "@/types/batch";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Loader2,
  XCircle,
} from "lucide-react";

interface ScanRankingProps {
  scans: BatchScan[];
  selectedJobId: string | null;
  onSelect: (jobId: string) => void;
  batchStatus: string;
}

const riskStyle = (scan: BatchScan) => {
  if (scan.status !== "completed") {
    return { label: "Pending", badge: "text-muted-foreground border-border" };
  }
  if (scan.hasCancer === false) {
    return { label: "No cancer", badge: RISK_BADGES.low };
  }
  const level = scanRiskLevel(scan);
  return { label: RISK_LABELS[level], badge: RISK_BADGES[level] };
};

const statusLine = (scan: BatchScan) => {
  if (scan.status === "completed") return null;
  if (scan.status === "failed") {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive">
        <XCircle className="h-3.5 w-3.5" />
        {scan.error ? "Analysis failed" : "Failed"}
      </span>
    );
  }
  if (scan.status === "running") {
    return (
      <span className="flex items-center gap-1 text-xs text-primary">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {scan.stage === "segmentation" ? "Segmenting" : "Analysing"}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <CircleDot className="h-3.5 w-3.5" />
      Queued
    </span>
  );
};

export const ScanRanking = ({
  scans,
  selectedJobId,
  onSelect,
  batchStatus,
}: ScanRankingProps) => {
  const ranked = rankScans(scans);
  const completed = scans.filter((scan) => scan.status === "completed").length;
  const positive = scans.filter((scan) => scan.hasCancer === true).length;

  return (
    <aside className="min-w-0">
      <div className="rounded-xl border border-border bg-card lg:sticky lg:top-24">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-foreground">
              Risk ranking
            </h2>
            <span className="text-xs text-muted-foreground">
              {completed}/{scans.length} done
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Highest malignancy score first ·{" "}
            {positive > 0
              ? `${positive} flagged for review`
              : "no positive scans yet"}
          </p>
        </div>

        <ol className="divide-y divide-border">
          {ranked.map((scan, index) => {
            const isSelected = scan.jobId === selectedJobId;
            const isDone = scan.status === "completed";
            const style = riskStyle(scan);

            return (
              <li key={scan.jobId}>
                <button
                  type="button"
                  onClick={() => onSelect(scan.jobId)}
                  className={cn(
                    "flex w-full items-start gap-3 px-4 py-3 text-left transition",
                    "hover:bg-secondary/60",
                    isSelected && "bg-primary/10",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {isDone ? index + 1 : "–"}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {scan.patientName}
                      </span>
                      {isDone && scan.malignancyScore !== null ? (
                        <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                          {Math.round(scan.malignancyScore)}%
                        </span>
                      ) : null}
                    </span>

                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      {isDone ? (
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                            style.badge,
                          )}
                        >
                          {style.label}
                        </span>
                      ) : (
                        statusLine(scan)
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        {batchStatus === "interrupted" && (
          <div className="flex items-start gap-2 border-t border-border bg-warning/10 px-4 py-3 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Analysis stopped before finishing. Restart to process the remaining
            scans.
          </div>
        )}

        {scans.length > 0 && completed === scans.length && (
          <div className="flex items-center gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            All {scans.length} scans analysed.
          </div>
        )}
      </div>
    </aside>
  );
};
