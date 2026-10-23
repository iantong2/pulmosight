import { AnalysisResult } from "@/types/patient";

interface MalignancyChartProps {
  result: AnalysisResult;
}

export const MalignancyChart = ({ result }: MalignancyChartProps) => {
  return (
    <div className="p-4 bg-card rounded-lg border border-border">
      <p className="text-sm text-muted-foreground mb-2">Nodules Detected</p>
      <p className="text-2xl font-bold text-foreground">
        {result.noduleCount}
      </p>
    </div>
  );
};
