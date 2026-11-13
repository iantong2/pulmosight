import { useNavigate, useLocation, useParams } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { CTScanViewer } from "@/components/CTScanViewer";
import { MalignancyChart } from "@/components/MalignancyChart";
import { MalignancyGauge } from "@/components/MalignancyGauge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { AnalysisResult, Patient } from "@/types/patient";
import { RiskLevel } from "@/types/batch";
import { apiUrl, readErrorMessage } from "@/lib/api";
import { ArrowLeft, Download, FileText, Layers, Loader2 } from "lucide-react";
import { useState, useEffect, useMemo, useRef } from "react";
import { toast } from "@/hooks/use-toast";

const emptyAnalysisResult: AnalysisResult = {
  malignancyScore: 0,
  confidence: 0,
  noduleCount: 0,
  coordinates: [],
  segmentationData: "",
  originalScan: "",
  findings: [],
};

type PipelineStage =
  | "idle"
  | "queued"
  | "classifying"
  | "segmenting"
  | "complete"
  | "error"
  | "cancelled";

type ClassificationResult = {
  has_cancer: boolean;
  confidence: number;
  label?: string;
};

type ApiAnalysisResponse = {
  status?: "pending" | "running" | "completed" | "failed";
  stage?: "queued" | "classification" | "segmentation" | "completed";
  error?: string;
  warnings?: string[];
  requestId?: string;
  classification?: {
    has_cancer?: boolean;
    confidence?: number;
    label?: string;
    threshold?: number;
    processing_time?: number;
  };
  segmentation?: {
    processing_time?: number;
    shape?: number[];
    maskUrl?: string;
    overlayUrl?: string;
    error?: string;
    failed?: boolean;
  } | null;
  malignancyScore?: number;
  confidence?: number;
  noduleCount?: number;
  coordinates?: Array<{ x: number; y: number; label: string }>;
  findings?: string[];
  originalScan?: string;
  segmentationImages?: string[];
};

const Analysis = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { jobId: routeParamJobId } = useParams<{ jobId: string }>();
  const patient = location.state?.patient as Patient | undefined;
  const routeJobId = location.state?.jobId as string | undefined;
  const cameFromHistory = location.state?.fromHistory === true;
  const cameFromReferral = location.state?.fromReferral === true;
  const [showSegmentation, setShowSegmentation] = useState(false);
  const [showResultsModal, setShowResultsModal] = useState(false);
  const [isStartingSegmentation, setIsStartingSegmentation] = useState(false);
  const [referralConfirmed, setReferralConfirmed] = useState(false);
  const [humanReview, setHumanReview] = useState(false);
  const [isRequestingHumanReview, setIsRequestingHumanReview] = useState(false);
  const [isReferring, setIsReferring] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [segmentImages, setSegmentImages] = useState<string[]>([]);
  const [classification, setClassification] =
    useState<ClassificationResult | null>(null);
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>("idle");
  const [stageMessage, setStageMessage] = useState(
    "Waiting to start analysis...",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [segmentationError, setSegmentationError] = useState<string | null>(
    null,
  );
  const [pollTick, setPollTick] = useState(0);
  const [pollingCancelled, setPollingCancelled] = useState(false);
  const activeController = useRef<AbortController | null>(null);
  const classificationModalShownRef = useRef(false);
  const allowClassificationModalRef = useRef(false);

  const hasSegmentation = segmentImages.length > 0;

  // The modal should only appear when the active classification pipeline reports
  // its first result. Historical or persisted fetches are not considered a new
  // classification result, so they are excluded from this trigger.
  useEffect(() => {
    if (
      !classification ||
      classificationModalShownRef.current ||
      !allowClassificationModalRef.current
    ) {
      return;
    }

    classificationModalShownRef.current = true;
    allowClassificationModalRef.current = false;
    setShowResultsModal(true);
  }, [classification]);

  const handleReturnToDashboard = () => {
    classificationModalShownRef.current = true;
    allowClassificationModalRef.current = false;
    setShowResultsModal(false);
    navigate(cameFromHistory ? "/history" : "/dashboard");
  };

  const handleSeeResult = () => {
    classificationModalShownRef.current = true;
    allowClassificationModalRef.current = false;
    setShowResultsModal(false);
  };

  const handleProceedToSegmentation = async () => {
    if (!jobId) {
      toast({
        title: "Segmentation unavailable",
        description: "This analysis is missing a valid job identifier.",
        variant: "destructive",
      });
      return;
    }

    setIsStartingSegmentation(true);

    try {
      const response = await fetch(apiUrl("/api/segmentation/run"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jobId,
          requestId: jobId,
          analysisId: jobId,
        }),
      });

      const raw = await response.text().catch(() => "");
      let data: { success?: boolean; error?: string } = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = {};
      }

      if (!response.ok || data.success === false) {
        throw new Error(
          data.error ||
            `Segmentation could not be started. (HTTP ${response.status})`,
        );
      }

      // Close the modal and move the user into the segmentation stage only after
      // the explicit user action. This keeps the backend trigger gated.
      classificationModalShownRef.current = true;
      allowClassificationModalRef.current = false;
      setShowResultsModal(false);
      setShowSegmentation(true);
      setPipelineStage("segmenting");
      setStageMessage(
        "Cancer detected. Running detailed segmentation analysis...",
      );
      setPollTick((prev) => prev + 1);

      toast({
        title: "Segmentation started",
        description: "The segmentation job is now running.",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to start segmentation.";
      toast({
        title: "Segmentation failed",
        description: message,
        variant: "destructive",
      });
      setPipelineStage("error");
      setStageMessage("Unable to start segmentation.");
    } finally {
      setIsStartingSegmentation(false);
    }
  };

  const updateStageUI = (
    stage?: ApiAnalysisResponse["stage"],
    status?: ApiAnalysisResponse["status"],
  ) => {
    if (status === "completed") {
      setPipelineStage("complete");
      setStageMessage("Analysis completed.");
      return;
    }
    if (status === "failed") {
      setPipelineStage("error");
      setStageMessage("Analysis failed.");
      return;
    }
    if (stage === "classification") {
      setPipelineStage("classifying");
      setStageMessage("Analyzing scan for cancer indicators...");
      return;
    }
    if (stage === "segmentation") {
      setPipelineStage("segmenting");
      setStageMessage(
        "Cancer detected. Running detailed segmentation analysis...",
      );
      return;
    }
    setPipelineStage("queued");
    setStageMessage("Scan uploaded. Preparing analysis job...");
  };

  const jobId = useMemo(() => {
    if (routeParamJobId) return routeParamJobId;
    if (routeJobId) return routeJobId;
    const raw = sessionStorage.getItem("analysisContext");
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { jobId?: string };
      return parsed.jobId;
    } catch {
      return undefined;
    }
  }, [routeParamJobId, routeJobId]);

  useEffect(() => {
    classificationModalShownRef.current = false;
    allowClassificationModalRef.current = false;
    setShowResultsModal(false);
  }, [jobId]);

  // A referral or a human-read request outlives the page: keep both actions in
  // their confirmed state after a refresh instead of inviting a duplicate.
  useEffect(() => {
    if (!jobId) return;

    let cancelled = false;

    const loadReviewState = async () => {
      const [referralRes, humanReviewRes] = await Promise.all([
        fetch(apiUrl(`/api/referrals/${jobId}`)).catch(() => null),
        fetch(apiUrl(`/api/human-review/${jobId}`)).catch(() => null),
      ]);
      if (cancelled) return;

      if (referralRes?.ok) setReferralConfirmed(true);
      else if (referralRes?.status === 404) setReferralConfirmed(false);

      setHumanReview(!!humanReviewRes?.ok);
    };

    loadReviewState();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Live analysis clock. Classification takes tens of seconds and the backend
  // only reports the stage it is in, so the elapsed time is what tells the user
  // the job is still moving rather than stuck.
  const pipelineRunning =
    pipelineStage === "queued" ||
    pipelineStage === "classifying" ||
    pipelineStage === "segmenting";

  useEffect(() => {
    if (!pipelineRunning) {
      setElapsedSec(0);
      return;
    }

    const startedAt = Date.now();
    setElapsedSec(0);
    const timer = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [pipelineRunning, pipelineStage]);

  useEffect(() => {
    if (!jobId) return;

    let cancelled = false;

    const loadFromPersistentApi = async () => {
      try {
        const res = await fetch(apiUrl(`/api/analysis/${jobId}`));
        if (!res.ok)
          throw new Error(
            await readErrorMessage(res, "Failed to fetch persisted analysis"),
          );
        const data: ApiAnalysisResponse = await res.json();

        if (cancelled) return;

        if (
          data.classification &&
          typeof data.classification.has_cancer === "boolean"
        ) {
          setClassification({
            has_cancer: Boolean(data.classification.has_cancer),
            confidence: Number(data.classification.confidence ?? 0),
            label: data.classification.label,
          });
        } else {
          setClassification(null);
        }

        const mappedResult: AnalysisResult = {
          malignancyScore: data.malignancyScore ?? 0,
          confidence: data.confidence ?? 0,
          noduleCount: data.noduleCount ?? 0,
          coordinates: data.coordinates ?? [],
          segmentationData: "",
          originalScan: data.originalScan ?? "",
          findings: data.findings ?? [],
        };

        setResult(mappedResult);
        setSegmentImages(data.segmentationImages ?? []);
        setShowSegmentation(
          (data.segmentationImages ?? []).length > 0 || !!data.segmentation,
        );
        updateStageUI(data.stage, data.status);

        if (data.segmentation?.failed) {
          setSegmentationError(
            data.segmentation.error ||
              "Segmentation failed after positive classification.",
          );
        } else {
          setSegmentationError(null);
        }
      } catch (error) {
        console.error("[Analysis] load from DB failed:", error);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Unable to load analysis details.",
        );
      }
    };

    loadFromPersistentApi();

    if (pollingCancelled) return;

    let timer: number | null = null;
    const fetchResult = async () => {
      activeController.current?.abort();
      const controller = new AbortController();
      activeController.current = controller;

      try {
        const res = await fetch(apiUrl(`/api/analysis/result/${jobId}`), {
          signal: controller.signal,
        });
        if (!res.ok)
          throw new Error(
            await readErrorMessage(res, "Failed to fetch analysis result"),
          );
        const data: ApiAnalysisResponse = await res.json();

        console.log("[Analysis] raw /result payload:", data);

        if (cancelled) return;
        setErrorMessage(null);

        updateStageUI(data.stage, data.status);

        if (
          data.classification &&
          typeof data.classification.has_cancer === "boolean"
        ) {
          const nextClassification = {
            has_cancer: Boolean(data.classification.has_cancer),
            confidence: Number(data.classification.confidence ?? 0),
            label: data.classification.label,
          };
          setClassification(nextClassification);
          if (data.stage === "classification") {
            allowClassificationModalRef.current = true;
          }
        } else {
          setClassification(null);
        }

        if (data.status === "failed") {
          throw new Error(data.error || "Analysis failed");
        }

        if (data.status !== "completed") {
          timer = window.setTimeout(fetchResult, 2500);
          return;
        }

        const mappedResult: AnalysisResult = {
          malignancyScore: data.malignancyScore ?? 0,
          confidence: data.confidence ?? 0,
          noduleCount: data.noduleCount ?? 0,
          coordinates: data.coordinates ?? [],
          segmentationData: "",
          originalScan: data.originalScan ?? "",
          findings: data.findings ?? [],
        };

        setResult(mappedResult);

        const nextSegmentImages = data.segmentationImages ?? [];
        setSegmentImages(nextSegmentImages);

        if (data.segmentation?.failed) {
          setSegmentationError(
            data.segmentation.error ||
              "Segmentation failed after positive classification.",
          );
        } else {
          setSegmentationError(null);
        }

        if (nextSegmentImages.length > 0 || data.segmentation) {
          setShowSegmentation(true);
        } else {
          setShowSegmentation(false);
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof DOMException && e.name === "AbortError") return;

        console.error("[Analysis] polling error:", e);
        const message =
          e instanceof Error ? e.message : "Failed to fetch analysis result";
        setErrorMessage(message);
        setPipelineStage("error");
        setStageMessage("Unable to retrieve analysis status.");
      }
    };

    fetchResult();
    return () => {
      cancelled = true;
      activeController.current?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [jobId, pollTick, pollingCancelled]);

  const handleCancelPolling = () => {
    setPollingCancelled(true);
    activeController.current?.abort();
    setPipelineStage("cancelled");
    setStageMessage("Analysis polling cancelled. You can retry anytime.");
  };

  const handleRetryPolling = () => {
    setPollingCancelled(false);
    setErrorMessage(null);
    setPipelineStage("queued");
    setPollTick((prev) => prev + 1);
  };

  const handleDownloadPDF = () => {
    toast({
      title: "Download Started",
      description: "Your analysis report is being generated...",
    });

    // Simulate PDF generation
    setTimeout(() => {
      toast({
        title: "Download Complete",
        description: "Analysis report has been saved.",
      });
    }, 2000);
  };

  const handleRequireHumanAnalysis = async () => {
    if (humanReview) return;

    if (!jobId) {
      toast({
        title: "Human review unavailable",
        description: "This analysis is missing a valid job identifier.",
        variant: "destructive",
      });
      return;
    }

    setIsRequestingHumanReview(true);
    try {
      const response = await fetch(apiUrl(`/api/human-review/${jobId}`), {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(
          await readErrorMessage(response, "Could not request human analysis"),
        );
      }

      // The backend also drops any existing referral for this case, so the
      // physician queue no longer offers a machine-decided referral.
      setHumanReview(true);
      setReferralConfirmed(false);
      toast({
        title: "Human analysis requested",
        description: "This case has been removed from the physician referral queue.",
      });
    } catch (err) {
      toast({
        title: "Request failed",
        description:
          err instanceof Error ? err.message : "Could not request human analysis.",
        variant: "destructive",
      });
    } finally {
      setIsRequestingHumanReview(false);
    }
  };

  const handleConfirmReferral = async () => {
    if (referralConfirmed) return;

    if (!jobId) {
      toast({
        title: "Referral unavailable",
        description: "This analysis is missing a valid job identifier.",
        variant: "destructive",
      });
      return;
    }

    setIsReferring(true);

    try {
      const response = await fetch(apiUrl("/api/referrals"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jobId }),
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Referral failed"));
      }

      setReferralConfirmed(true);
      // Stay on the analysis. Navigating away here made a routine follow-up
      // action look like the analysis page had sent the case on its own.
      toast({
        title: "Referred to corresponding physician",
        description: "The case is now in the Physician Portal queue.",
        action: (
          <button
            type="button"
            className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-xs font-medium"
            onClick={() => navigate("/physician/referrals")}
          >
            Open queue
          </button>
        ),
      });
    } catch (error) {
      toast({
        title: "Referral failed",
        description:
          error instanceof Error
            ? error.message
            : "Could not create the referral.",
        variant: "destructive",
      });
    } finally {
      setIsReferring(false);
    }
  };

  const classificationLabel = classification
    ? (classification.label ??
      (classification.has_cancer ? "malignant" : "benign"))
    : "pending";

  // Same banding as the batch ranking: the classifier's verdict decides, so a
  // malignant scan is never shown as low risk just because its score is small.
  const riskLevel: RiskLevel = classification
    ? classification.has_cancer
      ? "high"
      : "low"
    : (result?.malignancyScore ?? 0) >= 70
      ? "high"
      : (result?.malignancyScore ?? 0) >= 30
        ? "moderate"
        : "low";

  const classificationSentence = classification
    ? classification.has_cancer
      ? "Cancer detected by classification model."
      : "No cancer detected by classification model."
    : "Waiting for the classification model to finish evaluating this scan.";

  // Progress checkpoints per stage. Inside a stage the bar creeps towards the
  // next checkpoint using the elapsed time, but never crosses it before the
  // backend reports the next stage — so the number stays an estimate.
  const lastProgressRef = useRef(0);
  const progressPercent = useMemo(() => {
    const checkpoints: Record<
      PipelineStage,
      { base: number; cap: number; seconds: number }
    > = {
      idle: { base: 0, cap: 8, seconds: 30 },
      queued: { base: 8, cap: 18, seconds: 20 },
      classifying: { base: 18, cap: 62, seconds: 60 },
      segmenting: { base: 62, cap: 92, seconds: 90 },
      complete: { base: 100, cap: 100, seconds: 1 },
      error: { base: 100, cap: 100, seconds: 1 },
      cancelled: { base: 100, cap: 100, seconds: 1 },
    };
    const { base, cap, seconds } = checkpoints[pipelineStage];
    const ratio = Math.min(1, elapsedSec / seconds);
    return Math.round(base + (cap - base) * ratio);
  }, [pipelineStage, elapsedSec]);

  useEffect(() => {
    if (pipelineRunning) lastProgressRef.current = progressPercent;
  }, [pipelineRunning, progressPercent]);

  // A failed or cancelled run keeps the bar where it stopped; jumping to 100%
  // would suggest the analysis finished.
  const displayedProgress =
    pipelineStage === "error" || pipelineStage === "cancelled"
      ? lastProgressRef.current
      : progressPercent;

  const formatElapsed = (totalSeconds: number) =>
    `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(
      totalSeconds % 60,
    ).padStart(2, "0")}`;

  const stageStepLabel =
    pipelineStage === "classifying"
      ? "Step 2 of 3 · Classifying scan"
      : pipelineStage === "segmenting"
        ? "Step 3 of 3 · Segmenting nodule regions"
        : pipelineStage === "complete"
          ? "Step 3 of 3 · Completed"
          : pipelineStage === "queued"
            ? "Step 1 of 3 · Preparing job"
            : pipelineStage === "error"
              ? "Analysis failed"
              : pipelineStage === "cancelled"
                ? "Analysis cancelled"
                : "Waiting to start";

  const resultsModalTitle = classification?.has_cancer
    ? "Cancer indicators detected"
    : "No Cancer indicators detected";

  // Reflect the real pipeline state in the page header instead of always
  // claiming the analysis finished.
  const headerStatusText =
    pipelineStage === "complete"
      ? "Analysis completed"
      : pipelineStage === "error"
        ? "Analysis failed"
        : pipelineStage === "cancelled"
          ? "Analysis cancelled"
          : "Analysis in progress";

  return (
    <>
      {showResultsModal && classification && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
            <p className="text-sm text-muted-foreground">
              Classification result
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-foreground">
              {resultsModalTitle}
            </h2>

            <p className="mt-4 text-sm text-muted-foreground">
              {classification.has_cancer
                ? "This scan appears positive. You can return to the dashboard or continue with a manual segmentation review."
                : "This scan does not show the cancer indicators from the classifier. You can review the result or return to the dashboard."}
            </p>

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={handleReturnToDashboard}>
                {cameFromHistory ? "Return to History" : "Return to Dashboard"}
              </Button>

              {classification.has_cancer ? (
                <Button
                  onClick={handleProceedToSegmentation}
                  disabled={isStartingSegmentation}
                >
                  {isStartingSegmentation ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    "Proceed to Segmentation"
                  )}
                </Button>
              ) : (
                <Button variant="secondary" onClick={handleSeeResult}>
                  See Result
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="min-h-screen bg-background">
        {/* Header */}
        <header className="border-b border-border bg-card/50 backdrop-blur-xl sticky top-0 z-50">
          <div className="w-full px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Logo />
              <span className="hidden rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground sm:inline">
                Radiologist Portal
              </span>
            </div>

            <div className="flex items-center gap-4">
              {patient && (
                <div className="text-sm text-muted-foreground">
                  Patient:{" "}
                  <span className="text-foreground font-medium">
                    {patient.name}
                  </span>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="max-w-7xl mx-auto px-6 py-8">
          {/* Back Button & Title */}
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  navigate(
                    cameFromReferral
                      ? "/physician/referrals"
                      : cameFromHistory
                        ? "/history"
                        : "/dashboard",
                  )
                }
              >
                <ArrowLeft className="w-4 h-4" />
                {cameFromReferral
                  ? "Back to Physician Portal"
                  : cameFromHistory
                    ? "Back to History"
                    : "Back to Dashboard"}
              </Button>

              <div>
                <h1 className="text-2xl font-semibold text-foreground">
                  CT Scan Analysis Results
                </h1>
                <p className="text-muted-foreground mt-1">
                  {headerStatusText} •{" "}
                  {new Date().toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {(pipelineStage === "queued" ||
                pipelineStage === "classifying" ||
                pipelineStage === "segmenting") && (
                <Button variant="outline" onClick={handleCancelPolling}>
                  Cancel Processing
                </Button>
              )}
              <Button variant="glow" onClick={handleDownloadPDF}>
                <Download className="w-4 h-4" />
                Download Results as PDF
              </Button>
            </div>
          </div>

          <div className="mb-6 rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Pipeline Stage</p>
                <p className="text-base font-medium text-foreground">
                  {stageMessage}
                </p>
              </div>

              <div className="text-right">
                <p className="text-2xl font-semibold text-foreground">
                  {displayedProgress}%
                </p>
                <p className="text-xs text-muted-foreground">
                  {pipelineRunning
                    ? `Elapsed ${formatElapsed(elapsedSec)}`
                    : headerStatusText}
                </p>
              </div>
            </div>

            <Progress
              value={displayedProgress}
              className={`mt-3 h-2 ${
                pipelineStage === "error"
                  ? "[&>div]:bg-destructive"
                  : pipelineStage === "complete"
                    ? "[&>div]:bg-success"
                    : ""
              }`}
            />

            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{stageStepLabel}</span>
              <span>
                {pipelineRunning
                  ? "Estimated progress — final time depends on server load"
                  : ""}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1">
              <p className="text-sm text-muted-foreground">
                Classification:{" "}
                <span className="text-foreground">{classificationLabel}</span>
              </p>
            </div>
            {errorMessage && (
              <div className="mt-3">
                <p className="text-sm text-destructive">{errorMessage}</p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={handleRetryPolling}>
                    Retry
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate("/dashboard")}
                  >
                    Restart
                  </Button>
                </div>
              </div>
            )}
            {segmentationError && (
              <p className="text-sm text-warning mt-2">{segmentationError}</p>
            )}
          </div>

          {/* Main Content */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* CT Scan Viewers */}
            <div className="space-y-6">
              {/* Toggle */}
              <div className="flex items-center gap-4">
                <Button
                  variant={!showSegmentation ? "default" : "outline"}
                  size="sm"
                  onClick={() => setShowSegmentation(false)}
                >
                  <FileText className="w-4 h-4" />
                  Original Scan
                </Button>
                <Button
                  variant={showSegmentation ? "default" : "outline"}
                  size="sm"
                  onClick={() => setShowSegmentation(true)}
                  disabled={!hasSegmentation}
                >
                  <Layers className="w-4 h-4" />
                  Segmentation View
                </Button>
              </div>

              {/* CT Scan Viewer */}
              <CTScanViewer
                result={result ?? emptyAnalysisResult}
                showSegmentation={showSegmentation}
                segmentImages={segmentImages}
              />

              {!hasSegmentation && classification?.has_cancer === false && (
                <div className="bg-card border border-border rounded-lg p-4 text-sm text-muted-foreground">
                  Segmentation was skipped because classification was negative.
                </div>
              )}
            </div>

            {/* Analysis Results */}
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-foreground mb-4">
                  Analysis Metrics
                </h2>

                <div className="rounded-lg border border-border bg-card p-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    Malignancy Score
                  </p>
                  <div className="mt-3 flex justify-center">
                    <MalignancyGauge
                      score={result?.malignancyScore ?? 0}
                      riskLevel={riskLevel}
                    />
                  </div>
                </div>

                <div className="mt-4">
                  <MalignancyChart result={result ?? emptyAnalysisResult} />
                </div>

                <div className="mt-4 rounded-lg border border-border bg-card p-4">
                  <h3 className="text-sm font-medium text-foreground mb-2">
                    Classification Result
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {classificationSentence}
                  </p>
                </div>

                <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                  <Button
                    variant="outline"
                    onClick={handleRequireHumanAnalysis}
                    disabled={humanReview || isRequestingHumanReview}
                    title={
                      humanReview
                        ? "This case is flagged for a human read and is no longer in the referral queue"
                        : "Flag this case for a human read and remove it from the referral queue"
                    }
                  >
                    {isRequestingHumanReview
                      ? "Requesting..."
                      : humanReview
                        ? "Human analysis requested"
                        : "Require human analysis"}
                  </Button>
                  <Button
                    className="sm:flex-1"
                    onClick={handleConfirmReferral}
                    disabled={referralConfirmed || isReferring || humanReview}
                  >
                    {isReferring
                      ? "Referring..."
                      : referralConfirmed
                        ? "Referred to corresponding physician"
                        : "Confirm and refer to corresponding physicians"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </>
  );
};

export default Analysis;
