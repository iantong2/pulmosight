import { CTScanViewer } from "@/components/CTScanViewer";
import { MalignancyChart } from "@/components/MalignancyChart";
import { MalignancyGauge } from "@/components/MalignancyGauge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  RISK_BADGES,
  RISK_LABELS,
  scanRiskLevel,
} from "@/lib/batch";
import { AnalysisResult } from "@/types/patient";
import { BatchScan } from "@/types/batch";
import { FileText, Layers, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const emptyAnalysisResult: AnalysisResult = {
  malignancyScore: 0,
  confidence: 0,
  noduleCount: 0,
  coordinates: [],
  segmentationData: "",
  originalScan: "",
  findings: [],
};

interface ScanAnalysisPanelProps {
  scan: BatchScan;
  /** Shown only when the scan finished positive and has no segmentation yet. */
  onRunSegmentation?: () => Promise<void>;
  isRunningSegmentation?: boolean;
}

const stageCopy = (scan: BatchScan) => {
  if (scan.status === "completed") {
    return scan.stage === "segmentation"
      ? "Segmentation completed."
      : "Analysis completed.";
  }
  if (scan.status === "failed") return "Analysis failed.";
  if (scan.status === "running") {
    return scan.stage === "segmentation"
      ? "Cancer detected. Running detailed segmentation analysis..."
      : "Analysing scan for cancer indicators...";
  }
  return "Scan uploaded. Preparing analysis job...";
};

const stagePercent = (scan: BatchScan) => {
  if (scan.status === "completed") return 100;
  if (scan.status === "failed") return 100;
  if (scan.stage === "segmentation") return 72;
  if (scan.stage === "classification") return 40;
  return 10;
};

export const ScanAnalysisPanel = ({
  scan,
  onRunSegmentation,
  isRunningSegmentation = false,
}: ScanAnalysisPanelProps) => {
  const [showSegmentation, setShowSegmentation] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  const isRunning = scan.status === "running" || scan.status === "pending";
  const hasSegmentation = scan.segmentationImages.length > 0;

  useEffect(() => {
    setShowSegmentation(false);
    startedAtRef.current = null;
    setElapsedSec(0);
  }, [scan.jobId]);

  useEffect(() => {
    if (!isRunning) {
      setElapsedSec(0);
      return;
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const startedAt = startedAtRef.current;
    setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));

    const timer = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRunning, scan.stage]);

  const result: AnalysisResult = useMemo(
    () => ({
      malignancyScore: scan.malignancyScore ?? 0,
      confidence: scan.confidence ?? 0,
      noduleCount: scan.noduleCount ?? 0,
      coordinates: scan.coordinates ?? [],
      segmentationData: "",
      originalScan: scan.originalScan,
      findings: scan.findings ?? [],
    }),
    [
      scan.malignancyScore,
      scan.confidence,
      scan.noduleCount,
      scan.coordinates,
      scan.originalScan,
      scan.findings,
    ],
  );

  const classificationLabel = scan.classification
    ? (scan.classification.label ??
      (scan.classification.has_cancer ? "malignant" : "benign"))
    : "pending";

  const classificationSentence = scan.classification
    ? scan.classification.has_cancer
      ? "Cancer detected by classification model."
      : "No cancer detected by classification model."
    : isRunning
      ? "Waiting for the classification model to finish evaluating this scan."
      : "No classification result is available for this scan.";

  const formatElapsed = (totalSeconds: number) =>
    `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(
      totalSeconds % 60,
    ).padStart(2, "0")}`;

  return (
    <div className="min-w-0 space-y-6">
      {/* Selected scan header */}
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Scan analysis
        </p>
        <h1 className="mt-1 truncate text-2xl font-semibold text-foreground">
          {scan.patientName}
        </h1>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {scan.fileName || "—"}
        </p>
      </div>

      {/* Pipeline state */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Pipeline stage</p>
            <p className="text-base font-medium text-foreground">
              {stageCopy(scan)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold text-foreground">
              {stagePercent(scan)}%
            </p>
            <p className="text-xs text-muted-foreground">
              {isRunning ? `Elapsed ${formatElapsed(elapsedSec)}` : ""}
            </p>
          </div>
        </div>

        <Progress
          value={stagePercent(scan)}
          className={`mt-3 h-2 ${
            scan.status === "failed"
              ? "[&>div]:bg-destructive"
              : scan.status === "completed"
                ? "[&>div]:bg-success"
                : ""
          }`}
        />

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1">
          <p className="text-sm text-muted-foreground">
            Classification:{" "}
            <span className="text-foreground">{classificationLabel}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            Risk level:{" "}
            <span className="text-foreground">
              {RISK_LABELS[scanRiskLevel(scan)]}
            </span>
          </p>
        </div>

        {scan.status === "failed" && scan.error && (
          <p className="mt-3 text-sm text-destructive">{scan.error}</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        {/* CT scan viewer */}
        <div className="space-y-6">
          <div className="flex items-center gap-4">
            <Button
              variant={!showSegmentation ? "default" : "outline"}
              size="sm"
              onClick={() => setShowSegmentation(false)}
            >
              <FileText className="h-4 w-4" />
              Original Scan
            </Button>
            <Button
              variant={showSegmentation ? "default" : "outline"}
              size="sm"
              onClick={() => setShowSegmentation(true)}
              disabled={!hasSegmentation}
            >
              <Layers className="h-4 w-4" />
              Segmentation View
            </Button>
          </div>

          <CTScanViewer
            result={result}
            showSegmentation={showSegmentation}
            segmentImages={scan.segmentationImages}
          />

          {!hasSegmentation && scan.hasCancer === false && (
            <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
              Segmentation was skipped because classification was negative.
            </div>
          )}

          {!hasSegmentation &&
            scan.hasCancer === true &&
            scan.status === "completed" &&
            onRunSegmentation && (
              <div className="rounded-lg border border-border bg-card p-4">
                <p className="text-sm text-muted-foreground">
                  Cancer indicators were detected. Run segmentation to map the
                  suspicious regions on the scan.
                </p>
                <Button
                  className="mt-3 w-full sm:w-auto"
                  onClick={onRunSegmentation}
                  disabled={isRunningSegmentation}
                >
                  {isRunningSegmentation ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    "Proceed to Segmentation"
                  )}
                </Button>
              </div>
            )}
        </div>

        {/* Metrics */}
        <div className="space-y-6">
          <div>
            <h2 className="mb-4 text-lg font-semibold text-foreground">
              Analysis Metrics
            </h2>

            <div className="rounded-lg border border-border bg-card p-4 text-center">
              <p className="text-sm text-muted-foreground">Malignancy Score</p>
              <div className="mt-3 flex justify-center">
                <MalignancyGauge
                  score={result.malignancyScore}
                  riskLevel={scanRiskLevel(scan)}
                  hasCancer={scan.hasCancer}
                />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {scan.noduleCount > 0
                  ? `${scan.noduleCount} segmented nodule region${
                      scan.noduleCount === 1 ? "" : "s"
                    }`
                  : "No segmented nodule region"}
              </p>
            </div>

            <div className="mt-4">
              <MalignancyChart result={result} />
            </div>

            <div className="mt-4 rounded-lg border border-border bg-card p-4">
              <h3 className="mb-2 text-sm font-medium text-foreground">
                Classification Result
              </h3>
              <p className="text-sm text-muted-foreground">
                {classificationSentence}
              </p>
              <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                Risk level:{" "}
                <span
                  className={cn(
                    "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                    RISK_BADGES[scanRiskLevel(scan)],
                  )}
                >
                  {RISK_LABELS[scanRiskLevel(scan)]}
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
