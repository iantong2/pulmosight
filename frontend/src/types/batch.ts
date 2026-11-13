export type ScanStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RiskLevel = "high" | "moderate" | "low";

export interface BatchScan {
  jobId: string;
  /** The patient name, taken from the uploaded file name. */
  patientName: string;
  fileName: string;
  status: ScanStatus;
  stage: string;
  error?: string | null;
  malignancyScore: number | null;
  confidence: number | null;
  /** Risk band computed by the backend, so every screen shows the same one. */
  riskLevel?: RiskLevel;
  classification: {
    has_cancer: boolean;
    confidence: number;
    label?: string;
  } | null;
  hasCancer: boolean | null;
  originalScan: string;
  segmentationImages: string[];
  noduleCount: number;
  coordinates: { x: number; y: number; label: string }[];
  findings: string[];
}

export interface BatchSummary {
  batchId: string;
  createdAt?: string;
  scanCount: number;
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
  scans: BatchScan[];
}
