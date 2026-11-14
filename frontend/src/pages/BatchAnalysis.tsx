import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { ScanAnalysisPanel } from "@/components/ScanAnalysisPanel";
import { ScanRanking } from "@/components/ScanRanking";
import { activeScanId, rankScans, startSegmentation } from "@/lib/batch";
import { Button } from "@/components/ui/button";
import { useBatch } from "@/hooks/useBatch";
import { apiUrl, readErrorMessage } from "@/lib/api";
import { toast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2, RefreshCw, Send } from "lucide-react";

const BatchAnalysis = () => {
  const { batchId } = useParams<{ batchId: string }>();
  const navigate = useNavigate();
  const { batch, error, isLoading, resumePolling } = useBatch(batchId);

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isStartingSegmentation, setIsStartingSegmentation] = useState(false);
  const [isReferring, setIsReferring] = useState(false);
  const [referredJobIds, setReferredJobIds] = useState<string[]>([]);
  const [humanReviewJobIds, setHumanReviewJobIds] = useState<string[]>([]);
  const [isRequestingHumanReview, setIsRequestingHumanReview] = useState(false);
  const userPickedRef = useRef(false);

  const scans = useMemo(() => batch?.scans ?? [], [batch?.scans]);
  const scansKey = useMemo(
    () => scans.map((scan) => `${scan.jobId}:${scan.status}`).join("|"),
    [scans],
  );

  // Follow the pipeline while it runs: when a scan finishes, select the next
  // one being processed so its progress bar is what the reader sees.
  // The reader can still pick a scan by hand; once they do, the selection is
  // theirs and a finished scan is not swapped out from under them.
  useEffect(() => {
    if (scans.length === 0) return;

    const nextId = userPickedRef.current
      ? activeScanId(scans, selectedJobId)
      : activeScanId(scans, null);

    if (nextId) {
      setSelectedJobId((prev) => (prev === nextId ? prev : nextId));
    }
  }, [scans, selectedJobId]);

  const selected = scans.find((scan) => scan.jobId === selectedJobId) ?? null;

  // Referrals and human-read requests outlive the page: reflect both states on
  // every scan of the batch.
  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;

    const loadReviewState = async () => {
      const done = scans.filter((scan) => scan.status === "completed");
      const referred: string[] = [];
      const human: string[] = [];
      await Promise.all(
        done.map(async (scan) => {
          const [referralRes, humanRes] = await Promise.all([
            fetch(apiUrl(`/api/referrals/${scan.jobId}`)).catch(() => null),
            fetch(apiUrl(`/api/human-review/${scan.jobId}`)).catch(() => null),
          ]);
          if (referralRes?.ok) referred.push(scan.jobId);
          if (humanRes?.ok) human.push(scan.jobId);
        }),
      );
      if (cancelled) return;
      setReferredJobIds(referred);
      setHumanReviewJobIds(human);
    };

    loadReviewState();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, scansKey]);

  const handleRequireHumanAnalysis = async () => {
    if (!selected || humanReviewJobIds.includes(selected.jobId)) return;
    const jobId = selected.jobId;
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

      // The backend removes the referral, so the physician queue no longer
      // offers this case as a machine-decided referral.
      setHumanReviewJobIds((prev) =>
        prev.includes(jobId) ? prev : [...prev, jobId],
      );
      setReferredJobIds((prev) => prev.filter((id) => id !== jobId));
      toast({
        title: "Human analysis requested",
        description: `${selected.patientName} has been removed from the physician referral queue.`,
      });
    } catch (humanReviewError) {
      toast({
        title: "Request failed",
        description:
          humanReviewError instanceof Error
            ? humanReviewError.message
            : "Could not request human analysis.",
        variant: "destructive",
      });
    } finally {
      setIsRequestingHumanReview(false);
    }
  };

  const handleRunSegmentation = async () => {
    if (!selected) return;
    setIsStartingSegmentation(true);
    try {
      await startSegmentation(selected.jobId);
      toast({
        title: "Segmentation started",
        description: "The segmentation job is now running.",
      });
      await resumePolling();
    } catch (segmentationError) {
      toast({
        title: "Segmentation failed",
        description:
          segmentationError instanceof Error
            ? segmentationError.message
            : "Failed to start segmentation.",
        variant: "destructive",
      });
    } finally {
      setIsStartingSegmentation(false);
    }
  };

  const handleConfirmReferral = async () => {
    if (!selected) return;
    const jobId = selected.jobId;
    setIsReferring(true);
    try {
      const response = await fetch(apiUrl("/api/referrals"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Referral failed"));
      }

      // Stay on the batch: a referral is one action on one scan, and the
      // radiologist usually has more scans in this batch to review. Leaving the
      // page automatically made it look like analysis itself had triggered it.
      setReferredJobIds((prev) =>
        prev.includes(jobId) ? prev : [...prev, jobId],
      );
      toast({
        title: "Referred to corresponding physician",
        description: `${selected.patientName} is now in the Physician Portal queue.`,
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
    } catch (referralError) {
      toast({
        title: "Referral failed",
        description:
          referralError instanceof Error
            ? referralError.message
            : "Could not create the referral.",
        variant: "destructive",
      });
    } finally {
      setIsReferring(false);
    }
  };

  const handleRestart = async () => {
    if (!batchId) return;
    setIsRestarting(true);
    try {
      const response = await fetch(
        apiUrl(`/api/analysis/batches/${batchId}/retry`),
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Restart failed"));
      }
      toast({
        title: "Analysis restarted",
        description: "Unfinished scans are being processed again.",
      });
      await resumePolling();
    } catch (restartError) {
      toast({
        title: "Restart failed",
        description:
          restartError instanceof Error
            ? restartError.message
            : "Could not restart the batch.",
        variant: "destructive",
      });
    } finally {
      setIsRestarting(false);
    }
  };

  const completedCount = scans.filter((scan) => scan.status === "completed").length;
  const runningScan = scans.find((scan) => scan.status === "running");
  const batchStatusText = !batch
    ? "Loading batch..."
    : batch.status === "completed"
      ? `Analysis completed — ${completedCount} of ${scans.length} scans`
      : batch.status === "interrupted"
        ? "Analysis interrupted"
        : batch.status === "failed"
          ? "Analysis failed"
          : `Analysing ${runningScan?.patientName ?? "scans"} · ${completedCount} of ${scans.length} done`;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-card/50 backdrop-blur-xl">
        <div className="flex w-full items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="hidden rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground sm:inline">
              Radiologist Portal
            </span>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/physician/referrals")}
            >
              Physician Portal
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/dashboard")}
            >
              New analysis
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/dashboard")}
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-foreground">
                Batch CT Scan Analysis
              </h1>
              <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                {batch?.status === "running" && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                )}
                {batchStatusText}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {batch?.status === "interrupted" && (
              <Button
                variant="outline"
                onClick={handleRestart}
                disabled={isRestarting}
              >
                {isRestarting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Restart analysis
              </Button>
            )}

            <Button
              variant="outline"
              onClick={handleRequireHumanAnalysis}
              disabled={
                !selected ||
                selected.status !== "completed" ||
                isRequestingHumanReview ||
                humanReviewJobIds.includes(selected?.jobId ?? "")
              }
              title={
                humanReviewJobIds.includes(selected?.jobId ?? "")
                  ? "This scan is flagged for a human read and is no longer in the referral queue"
                  : "Flag this scan for a human read and remove it from the referral queue"
              }
            >
              {isRequestingHumanReview
                ? "Requesting..."
                : humanReviewJobIds.includes(selected?.jobId ?? "")
                  ? "Human analysis requested"
                  : "Require human analysis"}
            </Button>

            <Button
              variant="glow"
              onClick={handleConfirmReferral}
              disabled={
                !selected ||
                selected.status !== "completed" ||
                isReferring ||
                referredJobIds.includes(selected?.jobId ?? "") ||
                humanReviewJobIds.includes(selected?.jobId ?? "")
              }
            >
              <Send className="mr-2 h-4 w-4" />
              {isReferring
                ? "Referring..."
                : referredJobIds.includes(selected?.jobId ?? "")
                  ? "Referred to physician"
                  : "Confirm and refer to corresponding physicians"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {isLoading && !batch ? (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-5 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading batch...
          </div>
        ) : scans.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center text-muted-foreground">
            This batch has no scans. Start a new analysis from the dashboard.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            {selected ? (
              <ScanAnalysisPanel
                scan={selected}
                onRunSegmentation={handleRunSegmentation}
                isRunningSegmentation={isStartingSegmentation}
              />
            ) : (
              <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
                Select a scan from the ranking to view its analysis.
              </div>
            )}

            <ScanRanking
              scans={scans}
              selectedJobId={selectedJobId}
              onSelect={(jobId) => {
                userPickedRef.current = true;
                setSelectedJobId(jobId);
              }}
              batchStatus={batch?.status ?? "pending"}
            />
          </div>
        )}
      </main>
    </div>
  );
};

export default BatchAnalysis;
