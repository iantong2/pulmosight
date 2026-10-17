interface MalignancyGaugeProps {
  /** Malignancy score as a percentage (0-100). */
  score: number;
}

const RADIUS = 54;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const riskFor = (score: number) => {
  if (score < 30) return { label: "Low Risk", stroke: "stroke-primary" };
  if (score < 70) return { label: "Moderate Risk", stroke: "stroke-warning" };
  return { label: "High Risk", stroke: "stroke-destructive" };
};

export const MalignancyGauge = ({ score }: MalignancyGaugeProps) => {
  const value = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const { label, stroke } = riskFor(value);
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
