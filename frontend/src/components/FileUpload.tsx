import { useCallback, useState } from "react";
import { Upload, FileImage, X, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export const MAX_BATCH_SCANS = 10;

interface FileUploadProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
  disabled?: boolean;
  maxFiles?: number;
}

const formatSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

export const FileUpload = ({
  files,
  onFilesChange,
  disabled = false,
  maxFiles = MAX_BATCH_SCANS,
}: FileUploadProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      const dicoms = list.filter((file) =>
        file.name.toLowerCase().endsWith(".dcm"),
      );
      const rejectedCount = list.length - dicoms.length;

      const next = [...files];
      let duplicateCount = 0;

      for (const file of dicoms) {
        if (next.length >= maxFiles) break;
        // Keying on the name matches how the scan is named on the results page:
        // two files with the same name would be indistinguishable patients.
        if (next.some((existing) => existing.name === file.name)) {
          duplicateCount += 1;
          continue;
        }
        next.push(file);
      }

      const problems: string[] = [];
      if (rejectedCount > 0) {
        problems.push(`${rejectedCount} file(s) skipped — only .dcm is accepted.`);
      }
      if (duplicateCount > 0) {
        problems.push(`${duplicateCount} duplicate file(s) skipped.`);
      }
      if (next.length === maxFiles && dicoms.length > 0) {
        problems.push(`Limit is ${maxFiles} scans per analysis.`);
      }
      setNotice(problems.length > 0 ? problems.join(" ") : null);

      if (next.length !== files.length) onFilesChange(next);
    },
    [files, maxFiles, onFilesChange],
  );

  const removeFile = (index: number) => {
    onFilesChange(files.filter((_, fileIndex) => fileIndex !== index));
    setNotice(null);
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragging(true);
    } else if (e.type === "dragleave") {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (disabled) return;
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles, disabled],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
    }
    // Allow re-selecting the same file after removing it.
    e.target.value = "";
  };

  const remaining = Math.max(0, maxFiles - files.length);

  return (
    <div className="space-y-4">
      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        className={cn(
          "relative rounded-lg border-2 border-dashed p-8 transition-all duration-200",
          disabled
            ? "cursor-not-allowed border-border opacity-60"
            : "cursor-pointer hover:border-primary/50 hover:bg-secondary/50",
          isDragging && !disabled && "border-primary bg-primary/10",
          files.length > 0 && !isDragging && "border-border",
        )}
      >
        <input
          type="file"
          accept=".dcm"
          multiple
          disabled={disabled}
          onChange={handleChange}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <div className="flex flex-col items-center gap-3 text-center">
          <div
            className={cn(
              "flex h-14 w-14 items-center justify-center rounded-full transition-colors",
              isDragging ? "bg-primary/20" : "bg-muted",
            )}
          >
            {isDragging ? (
              <FileImage className="h-7 w-7 text-primary" />
            ) : (
              <Upload className="h-7 w-7 text-muted-foreground" />
            )}
          </div>
          <div>
            <p className="font-medium text-foreground">
              {isDragging
                ? "Drop CT scans here"
                : files.length > 0
                  ? "Drag & drop more scans"
                  : "Drag & drop CT scans"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              or click to browse — up to {maxFiles} DICOM (.dcm) files
            </p>
          </div>
        </div>
      </div>

      {notice && <p className="text-sm text-warning">{notice}</p>}

      {files.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <p className="text-muted-foreground">
              {files.length} of {maxFiles} scans selected
            </p>
            {remaining > 0 && (
              <p className="text-xs text-muted-foreground">
                {remaining} slot{remaining === 1 ? "" : "s"} left
              </p>
            )}
          </div>

          <ul className="space-y-2">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="flex items-center justify-between rounded-lg border border-border bg-card p-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/20">
                    <CheckCircle className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {file.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Patient: {file.name.replace(/\.dcm$/i, "")} ·{" "}
                      {formatSize(file.size)}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  disabled={disabled}
                  className="group shrink-0 rounded-lg p-2 transition-colors hover:bg-destructive/20 disabled:opacity-50"
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="h-5 w-5 text-muted-foreground group-hover:text-destructive" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
