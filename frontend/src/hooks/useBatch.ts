import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, readErrorMessage } from "@/lib/api";
import { BatchSummary } from "@/types/batch";

const POLL_INTERVAL_MS = 2500;

/**
 * Poll a batch until every scan has finished (or the batch is interrupted).
 *
 * The polling stops on terminal states, so a completed batch does not keep
 * hitting the backend while the radiologist reads the results.
 */
export const useBatch = (batchId: string | undefined) => {
  const [batch, setBatch] = useState<BatchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pollTick, setPollTick] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!batchId) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    timerRef.current = null;

    const poll = async () => {
      try {
        const res = await fetch(apiUrl(`/api/analysis/batches/${batchId}`));
        if (!res.ok) {
          throw new Error(await readErrorMessage(res, "Failed to load batch"));
        }
        const data: BatchSummary = await res.json();
        if (cancelled) return;

        setBatch(data);
        setError(null);

        const terminal =
          data.status === "completed" ||
          data.status === "failed" ||
          data.status === "interrupted";
        if (!terminal) {
          timerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (pollError) {
        if (cancelled) return;
        setError(
          pollError instanceof Error
            ? pollError.message
            : "Failed to load batch",
        );
        // Keep trying: a transient network hiccup should not freeze the page.
        timerRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [batchId, pollTick]);

  const refresh = useCallback(async () => {
    if (!batchId) return;
    try {
      const res = await fetch(apiUrl(`/api/analysis/batches/${batchId}`));
      if (!res.ok) return;
      setBatch(await res.json());
    } catch {
      // Ignore: the next poll retries anyway.
    }
  }, [batchId]);

  /** Fetch now and resume polling — used after a restart or a segmentation run. */
  const resumePolling = useCallback(async () => {
    await refresh();
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setPollTick((tick) => tick + 1);
  }, [refresh]);

  return { batch, error, isLoading, refresh, resumePolling };
};

