import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiUrl, readErrorMessage } from "@/lib/api";
import { toast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  ClipboardList,
  LayoutDashboard,
  Loader2,
  User,
  Users,
} from "lucide-react";

type RiskLevel = "high" | "moderate" | "low";

interface Referral {
  jobId: string;
  patientId: string;
  patientName: string;
  age?: number | string | null;
  gender?: string | null;
  riskLevel: RiskLevel;
  malignancyScore: number | null;
  isCancer: boolean;
  confidence?: number | null;
  reason: string;
  assignedService: string;
  status: string;
  referredAt?: string;
  acceptedAt?: string | null;
  originalScan: string;
}

const RISK_STYLES: Record<
  RiskLevel,
  { label: string; badge: string; text: string }
> = {
  high: {
    label: "High risk",
    badge: "bg-destructive/15 text-destructive border-destructive/40",
    text: "text-destructive",
  },
  moderate: {
    label: "Moderate risk",
    badge: "bg-warning/15 text-warning border-warning/40",
    text: "text-warning",
  },
  low: {
    label: "Low risk",
    badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40",
    text: "text-emerald-400",
  },
};

const riskStyle = (level: RiskLevel) => RISK_STYLES[level] ?? RISK_STYLES.low;

const formatWhen = (value?: string | null) => {
  if (!value) return "—";
  // SQLite CURRENT_TIMESTAMP is UTC without a timezone marker ("2026-10-18 07:12:00").
  // Without the "Z" the browser would read it as local time and show a skewed hour.
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const ReferralQueue = () => {
  const navigate = useNavigate();
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [acceptingJobId, setAcceptingJobId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadQueue = async () => {
      try {
        const res = await fetch(apiUrl("/api/referrals"));
        if (!res.ok) {
          throw new Error(
            await readErrorMessage(res, "Failed to load the referral queue"),
          );
        }

        const data: Referral[] = await res.json();
        if (cancelled) return;

        setReferrals(data);
        setSelectedJobId((prev) =>
          prev && data.some((item) => item.jobId === prev)
            ? prev
            : (data[0]?.jobId ?? null),
        );
        setError(null);
      } catch (loadError) {
        if (cancelled) return;
        console.error("[ReferralQueue] failed to load referrals:", loadError);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load the referral queue",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadQueue();
    return () => {
      cancelled = true;
    };
  }, []);

  const pendingReferrals = useMemo(
    () => referrals.filter((item) => item.status !== "accepted"),
    [referrals],
  );

  const selected = useMemo(
    () =>
      referrals.find((item) => item.jobId === selectedJobId) ??
      pendingReferrals[0] ??
      referrals[0] ??
      null,
    [referrals, pendingReferrals, selectedJobId],
  );

  // The banner mirrors "a new high-risk referral came in": the newest high-risk
  // case that the physician has not accepted yet.
  const latestHighRisk = useMemo(
    () =>
      [...pendingReferrals]
        .filter((item) => item.riskLevel === "high")
        .sort(
          (a, b) =>
            new Date(b.referredAt ?? 0).getTime() -
            new Date(a.referredAt ?? 0).getTime(),
        )[0] ?? null,
    [pendingReferrals],
  );

  const handleAccept = async (referral: Referral) => {
    setAcceptingJobId(referral.jobId);
    try {
      const res = await fetch(
        apiUrl(`/api/referrals/${referral.jobId}/accept`),
        { method: "POST" },
      );
      if (!res.ok) {
        throw new Error(
          await readErrorMessage(res, "Could not accept this case"),
        );
      }

      const updated: Referral = await res.json();
      setReferrals((prev) =>
        prev.map((item) => (item.jobId === updated.jobId ? updated : item)),
      );
      setSelectedJobId(updated.jobId);
      toast({
        title: "Case accepted",
        description: `${updated.patientName} has been accepted into your review list.`,
      });
    } catch (acceptError) {
      toast({
        title: "Accept failed",
        description:
          acceptError instanceof Error
            ? acceptError.message
            : "Could not accept this case.",
        variant: "destructive",
      });
    } finally {
      setAcceptingJobId(null);
    }
  };

  const openCase = (referral: Referral) => {
    navigate(`/analysis/${referral.jobId}`, {
      state: {
        jobId: referral.jobId,
        fromReferral: true,
        patient: { id: referral.patientId, name: referral.patientName },
      },
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="flex min-h-screen">
        {/* Sidebar */}
        <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-[hsl(var(--sidebar-background))] lg:flex">
          <div className="border-b border-border px-5 py-5">
            <Logo />
            <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              General Hospital
            </p>
          </div>

          <nav className="flex-1 space-y-1 px-3 py-4">
            <button
              type="button"
              onClick={() => navigate("/dashboard")}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <LayoutDashboard className="h-4 w-4" />
              Overview
            </button>
            <div className="flex w-full items-center gap-3 rounded-md bg-primary/10 px-3 py-2 text-sm font-medium text-primary">
              <ClipboardList className="h-4 w-4" />
              Referral queue
            </div>
            <button
              type="button"
              onClick={() => navigate("/history")}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <Users className="h-4 w-4" />
              Patients
            </button>
            <button
              type="button"
              onClick={() =>
                toast({
                  title: "Appointments",
                  description:
                    "Appointment scheduling is not available yet — nothing was changed.",
                })
              }
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <Calendar className="h-4 w-4" />
              Appointments
            </button>
          </nav>

          <div className="border-t border-border px-5 py-4 text-sm">
            <div className="flex items-center gap-2 text-foreground">
              <User className="h-4 w-4 text-muted-foreground" />
              Dr. Amanda Lee
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Respiratory Medicine
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <header className="sticky top-0 z-40 border-b border-border bg-card/50 backdrop-blur-xl">
            <div className="flex items-center justify-between px-6 py-4">
              <div className="lg:hidden">
                <Logo />
              </div>
              <p className="hidden text-sm text-muted-foreground lg:block">
                PulmoSight General Hospital
              </p>

              <div className="flex items-center gap-3 text-sm">
                <span className="hidden rounded-full border border-border px-3 py-1 text-muted-foreground sm:inline">
                  Respiratory Medicine
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate("/dashboard")}
                >
                  <ArrowLeft className="mr-1 h-4 w-4" />
                  Dashboard
                </Button>
              </div>
            </div>
          </header>

          <main className="flex-1 px-6 py-8">
            <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
              {/* Queue */}
              <section className="min-w-0">
                <div>
                  <h1 className="text-2xl font-semibold text-foreground">
                    Physician referral queue
                  </h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    High-risk cases are prioritised for earlier review.
                  </p>
                </div>

                {latestHighRisk && (
                  <button
                    type="button"
                    onClick={() => setSelectedJobId(latestHighRisk.jobId)}
                    className="mt-6 flex w-full items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-left transition hover:border-destructive/60"
                  >
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                    <div>
                      <p className="text-sm font-medium text-destructive">
                        New high-risk referral received —{" "}
                        {latestHighRisk.patientName} (
                        {latestHighRisk.patientId || "unknown ID"})
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Radiology-confirmed · Automatically prioritised
                      </p>
                    </div>
                  </button>
                )}

                <div className="mt-6 rounded-lg border border-border bg-card">
                  <div className="flex items-center justify-between border-b border-border px-5 py-4">
                    <h2 className="text-base font-semibold text-foreground">
                      Pending referrals
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      Priority: high first
                    </span>
                  </div>

                  {loading ? (
                    <div className="flex items-center gap-2 px-5 py-10 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading referral queue...
                    </div>
                  ) : error ? (
                    <div className="px-5 py-10 text-sm text-destructive">
                      {error}
                    </div>
                  ) : referrals.length === 0 ? (
                    <div className="px-5 py-12 text-center">
                      <p className="text-sm text-muted-foreground">
                        No referrals in the queue yet.
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Confirm an analysis to send a case to this physician.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-4"
                        onClick={() => navigate("/dashboard")}
                      >
                        Back to Dashboard
                      </Button>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-16">Priority</TableHead>
                          <TableHead>Patient</TableHead>
                          <TableHead>Risk</TableHead>
                          <TableHead>Referral status</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {referrals.map((referral, index) => {
                          const isSelected =
                            referral.jobId === selected?.jobId;
                          const isAccepted = referral.status === "accepted";
                          const style = riskStyle(referral.riskLevel);

                          return (
                            <TableRow
                              key={referral.jobId}
                              data-state={isSelected ? "selected" : undefined}
                              className="cursor-pointer"
                              onClick={() => setSelectedJobId(referral.jobId)}
                            >
                              <TableCell className="font-mono text-sm text-muted-foreground">
                                #{index + 1}
                              </TableCell>
                              <TableCell>
                                <div className="font-medium text-foreground">
                                  {referral.patientName}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {referral.patientId || "—"}
                                </div>
                              </TableCell>
                              <TableCell>
                                <span
                                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${style.badge}`}
                                >
                                  {style.label}
                                </span>
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {isAccepted
                                  ? "Accepted"
                                  : "Awaiting physician review"}
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  size="sm"
                                  variant={
                                    index === 0 && !isAccepted
                                      ? "default"
                                      : "outline"
                                  }
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setSelectedJobId(referral.jobId);
                                    openCase(referral);
                                  }}
                                >
                                  {index === 0 && !isAccepted
                                    ? "Review Case"
                                    : "Open"}
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </section>

              {/* Priority case */}
              <aside className="min-w-0">
                <div className="rounded-lg border border-border bg-card xl:sticky xl:top-24">
                  <div className="flex items-center justify-between border-b border-border px-5 py-4">
                    <h2 className="text-base font-semibold text-foreground">
                      Priority case
                    </h2>
                    {selected && (
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${riskStyle(selected.riskLevel).badge}`}
                      >
                        {riskStyle(selected.riskLevel).label}
                      </span>
                    )}
                  </div>

                  {selected ? (
                    <div className="space-y-4 p-5">
                      <div>
                        <h3 className="text-lg font-semibold text-foreground">
                          {selected.patientName}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Patient ID: {selected.patientId || "—"}
                        </p>
                      </div>

                      <div className="overflow-hidden rounded-md border border-border bg-muted/30">
                        {selected.originalScan ? (
                          <img
                            src={selected.originalScan}
                            alt={`CT scan preview for ${selected.patientName}`}
                            className="h-48 w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
                            No scan preview available for this case.
                          </div>
                        )}
                      </div>

                      <dl className="space-y-2 text-sm">
                        <div className="flex items-start justify-between gap-4">
                          <dt className="text-muted-foreground">
                            Referral source
                          </dt>
                          <dd className="text-right text-foreground">
                            Radiology
                          </dd>
                        </div>
                        <div className="flex items-start justify-between gap-4">
                          <dt className="text-muted-foreground">
                            Assigned service
                          </dt>
                          <dd className="text-right text-foreground">
                            {selected.assignedService}
                          </dd>
                        </div>
                        <div className="flex items-start justify-between gap-4">
                          <dt className="text-muted-foreground">Malignancy</dt>
                          <dd className="text-right text-foreground">
                            {typeof selected.malignancyScore === "number"
                              ? `${selected.malignancyScore}%`
                              : "—"}
                          </dd>
                        </div>
                        <div className="flex items-start justify-between gap-4">
                          <dt className="text-muted-foreground">Referred</dt>
                          <dd className="text-right text-foreground">
                            {formatWhen(selected.referredAt)}
                          </dd>
                        </div>
                        <div className="flex items-start justify-between gap-4">
                          <dt className="text-muted-foreground">
                            Reason for referral
                          </dt>
                          <dd className="max-w-[60%] text-right text-foreground">
                            {selected.reason || "—"}
                          </dd>
                        </div>
                      </dl>

                      <div className="space-y-2 pt-2">
                        <Button
                          className="w-full"
                          onClick={() => openCase(selected)}
                        >
                          Review CT and case details
                        </Button>
                        <Button
                          variant="outline"
                          className="w-full"
                          disabled={
                            selected.status === "accepted" ||
                            acceptingJobId === selected.jobId
                          }
                          onClick={() => handleAccept(selected)}
                        >
                          {acceptingJobId === selected.jobId && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          {selected.status === "accepted"
                            ? "Case accepted"
                            : "Accept case"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="px-5 py-10 text-sm text-muted-foreground">
                      {loading
                        ? "Loading cases..."
                        : "Select a referral to review its case details."}
                    </div>
                  )}
                </div>
              </aside>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
};

export default ReferralQueue;
