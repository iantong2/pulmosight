import { RiskLevel } from "@/types/batch";

interface MalignancyGaugeProps {
  /** Malignancy score as a percentage (0-100). */
  score: number;
  /**
   * Risk band from the backend. When omitted the band falls back to score-only
   * thresholds, which can disagree with the classifier's verdict.
   */
  riskLevel?: RiskLevel;
  /** Classifier verdict, used only when no risk band was supplied. */
  hasCancer?: boolean | null;
}

const RADIUS = 54;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const STYLES: Record<RiskLevel, { label: string; stroke: string }> = {
  low: { label: "Low Risk", stroke: "stroke-primary" },
  moderate: { label: "Moderate Risk", stroke: "stroke-warning" },
  high: { label: "High Risk", stroke: "stroke-destructive" },
};

const riskFor = (score: number, riskLevel?: RiskLevel, hasCancer?: boolean | null) => {
  if (riskLevel) return STYLES[riskLevel];
  // Mirrors the backend banding: the classifier's verdict wins over the score.
  if (hasCancer === true) return STYLES.high;
  if (hasCancer === false) return STYLES.low;
  if (score >= 70) return STYLES.high;
  if (score >= 30) return STYLES.moderate;
  return STYLES.low;
};

export const MalignancyGauge = ({
  score,
  riskLevel,
  hasCancer,
}: MalignancyGaugeProps) => {
  const value = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const { label, stroke } = riskFor(value, riskLevel, hasCancer);
  const filled = (value / 100) * CIRCUMFERENCE;

  return (
    <div className="flex flex-col items-center">
      <div className="relative h-40 w-40">
        <svg
          viewBox="0 0 140 140"
          className="h-full w-full -rotate-90"
          role="img"
          aria-label={`Malignancy score ${value} percent — ${label}`}
        >
          <circle
            cx="70"
            cy="70"
            r={RADIUS}
            fill="none"
            strokeWidth="10"
            className="stroke-muted"
          />
          <circle
            cx="70"
            cy="70"
            r={RADIUS}
            fill="none"
            strokeWidth="10"
            strokeLinecap="round"
            className={stroke}
            strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
            style={{ transition: "stroke-dasharray 600ms ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-3xl font-semibold text-foreground">
            {value}%
          </span>
        </div>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{label}</p>
    </div>
  );
};
