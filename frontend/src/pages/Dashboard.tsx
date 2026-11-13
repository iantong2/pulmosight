import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { FileUpload, MAX_BATCH_SCANS } from "@/components/FileUpload";
import { Button } from "@/components/ui/button";
import { apiUrl, readErrorMessage } from "@/lib/api";
import { LogOut, Play, User, UploadCloud, ListOrdered } from "lucide-react";

const Dashboard = () => {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const navigate = useNavigate();

  const handleStartAnalysis = async () => {
    if (selectedFiles.length === 0) return;

    setAnalysisError(null);
    setIsStarting(true);

    try {
      const unsupported = selectedFiles.find(
        (file) => !file.name.toLowerCase().endsWith(".dcm"),
      );
      if (unsupported) {
        throw new Error(
          `Unsupported file type: ${unsupported.name}. Please upload DICOM (.dcm) files.`,
        );
      }

      // Every scan is its own patient, named after its file, and the batch is
      // uploaded in one request so the backend can rank the scans together.
      const formData = new FormData();
      for (const file of selectedFiles) {
        formData.append("ctScans", file, file.name);
      }

      const res = await fetch(apiUrl("/api/analysis/batch"), {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(await readErrorMessage(res, "Upload failed"));
      }

      const data: { batchId?: string; jobIds?: string[] } = await res.json();
      if (!data.batchId) throw new Error("Missing batchId from server response.");

      sessionStorage.setItem(
        "analysisContext",
        JSON.stringify({
          batchId: data.batchId,
          scanCount: selectedFiles.length,
          startedAt: Date.now(),
        }),
      );

      navigate(`/analysis/batch/${data.batchId}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start analysis";
      setAnalysisError(message);
    } finally {
      setIsStarting(false);
    }
  };

  const handleLogout = () => {
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-card/50 backdrop-blur-xl">
        <div className="flex w-full items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Logo />
            <span className="hidden rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground sm:inline">
              Radiologist Portal
            </span>
          </div>

          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/history")}
            >
              View History
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/physician/referrals")}
            >
              Physician Portal
            </Button>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <User className="h-4 w-4" />
              <span>Dr. Smith</span>
            </div>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="h-4 w-4" />
              <span>Logout</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-semibold text-foreground">
            New CT Scan Analysis
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">
            Upload up to {MAX_BATCH_SCANS} DICOM scans. Each file is analysed as
            one patient — the patient name is the file name — and the results are
            ranked by risk after the run.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15">
              <UploadCloud className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">
                Upload CT scans
              </h2>
              <p className="text-sm text-muted-foreground">
                One patient per file, ranked by malignancy risk once analysed.
              </p>
            </div>
          </div>

          {analysisError && (
            <p className="mb-4 text-sm text-destructive">{analysisError}</p>
          )}

          <FileUpload
            files={selectedFiles}
            onFilesChange={setSelectedFiles}
            disabled={isStarting}
            maxFiles={MAX_BATCH_SCANS}
          />

          <Button
            variant="glow"
            size="lg"
            className="mt-6 w-full"
            disabled={selectedFiles.length === 0 || isStarting}
            onClick={handleStartAnalysis}
          >
            <Play className="h-4 w-4" />
            {isStarting
              ? "Starting analysis..."
              : selectedFiles.length > 1
                ? `Analyse ${selectedFiles.length} scans`
                : "Start Analysis"}
          </Button>

          <p className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <ListOrdered className="h-3.5 w-3.5" />
            Scans are processed one after another; the risk ranking fills in as
            each scan finishes.
          </p>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
