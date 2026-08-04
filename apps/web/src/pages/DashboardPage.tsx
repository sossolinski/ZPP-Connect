import { useEffect, useState, type ComponentType } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  CalendarDays,
  CircleHelp,
  ClipboardList,
  Database,
  FileText,
  FileWarning,
  HeartPulse,
  Link2,
  ListTodo,
  PieChart,
  PhoneCall,
  RadioTower,
  ShieldAlert,
  UserCheck,
  UsersRound,
  X
} from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useApp } from "../lib/app-context";
import type { DemoUser, PortalRouteKey } from "../lib/portal-types";
import type { AnyRecord } from "../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, Loading, StatusBadge } from "../components/ui";

type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "exercise";
type DashboardSlice = {
  key: string;
  label: string;
  value: number;
  tone: BadgeTone;
  color: string;
};
type QualityDashboardItem = {
  label: string;
  value: number;
  detail: string;
  tone: "neutral" | "success" | "warning" | "danger";
};
type QuickActionItem = {
  title: string;
  detail: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  primary?: boolean;
};

function num(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pct(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function toneFor(value?: string): BadgeTone {
  if (value === "success" || value === "info" || value === "warning" || value === "danger" || value === "exercise") return value;
  return "neutral";
}

function MetricTile({
  label,
  value,
  detail,
  icon: Icon,
  tone = "neutral",
  to
}: {
  label: string;
  value: number | string;
  detail: string;
  icon: ComponentType<{ className?: string }>;
  tone?: "neutral" | "success" | "info" | "warning" | "danger";
  to?: string;
}) {
  const tones = {
    neutral: "bg-muted text-muted-foreground",
    success: "bg-emerald-50 text-emerald-800",
    info: "bg-blue-50 text-blue-800",
    warning: "bg-amber-50 text-amber-900",
    danger: "bg-red-50 text-red-800"
  };
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-muted-foreground">{label}</p>
          <p className="mt-2 truncate text-3xl font-black leading-none text-foreground">{value}</p>
          <p className="mt-2 text-sm font-semibold text-muted-foreground">{detail}</p>
        </div>
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${tones[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      {to ? (
        <span className="mt-3 inline-flex items-center gap-1 text-xs font-black text-[#145C63] dark:text-[#7ed7dc]">
          Open details
          <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
        </span>
      ) : null}
    </>
  );
  const className = "rounded-md border border-border bg-card p-4 text-foreground";
  return to ? (
    <Link
      to={to}
      aria-label={`Open ${label}`}
      className={`${className} group transition hover:-translate-y-0.5 hover:border-[#145C63]/40 hover:shadow-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#145C63]`}
    >
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}

function CompactStat({
  label,
  value,
  detail,
  icon: Icon,
  tone = "neutral"
}: {
  label: string;
  value: number | string;
  detail: string;
  icon: ComponentType<{ className?: string }>;
  tone?: "neutral" | "success" | "info" | "warning" | "danger";
}) {
  const tones = {
    neutral: "bg-card text-muted-foreground",
    success: "bg-emerald-50 text-emerald-800",
    info: "bg-blue-50 text-blue-800",
    warning: "bg-amber-50 text-amber-900",
    danger: "bg-red-50 text-red-800"
  };
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-md border border-border bg-muted p-3 text-foreground">
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${tones[tone]}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-bold text-muted-foreground">{label}</p>
        <p className="mt-1 truncate text-2xl font-black leading-none text-foreground">{value}</p>
        <p className="mt-1 line-clamp-2 text-xs font-semibold text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function MatchingProgressSummary({ slices, total, complete }: { slices: DashboardSlice[]; total: number; complete: number }) {
  const completePercent = pct(complete, total);
  const segmentTotal = Math.max(
    total,
    slices.reduce((sum, slice) => sum + slice.value, 0),
    1
  );
  const visibleSegments = slices.filter((slice) => slice.value > 0);
  return (
    <div className="grid gap-3">
      <div className="min-w-0">
        <p className="text-3xl font-black leading-none text-foreground">{completePercent}%</p>
        <p className="mt-1 text-xs font-bold uppercase text-muted-foreground">complete</p>
      </div>

      <div className="flex h-3 overflow-hidden rounded-full bg-muted">
        {visibleSegments.length ? (
          visibleSegments.map((slice) => (
            <span
              key={slice.key}
              className="h-full"
              style={{
                width: `${Math.max((slice.value / segmentTotal) * 100, 2)}%`,
                backgroundColor: slice.color
              }}
            />
          ))
        ) : (
          <span className="h-full w-full bg-muted" />
        )}
      </div>

      {visibleSegments.length ? (
        <div className="flex flex-wrap gap-2">
          {visibleSegments.map((slice) => (
            <span key={slice.key} className="inline-flex min-w-0 items-center gap-2 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-bold text-muted-foreground">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
              <span className="truncate">{slice.label}</span>
              <Badge tone={toneFor(slice.tone)} className="px-1.5">
                {slice.value}
              </Badge>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QualityItem({ label, value, detail, tone = "neutral" }: { label: string; value: number; detail: string; tone?: "neutral" | "success" | "warning" | "danger" }) {
  return (
    <div className="rounded-md border border-border bg-muted p-3 text-foreground">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-muted-foreground">{label}</p>
        <Badge tone={tone}>{value}</Badge>
      </div>
      <p className="mt-2 text-xs font-semibold text-muted-foreground">{detail}</p>
    </div>
  );
}

function QuickActionCard({ action, step }: { action: QuickActionItem; step: number }) {
  const Icon = action.icon;
  return (
    <Link
      to={action.to}
      className={[
        "group flex min-w-0 items-start gap-3 rounded-md border p-3 transition hover:-translate-y-0.5 hover:shadow-panel focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#145C63]",
        action.primary
          ? "border-[#145C63]/25 bg-[#145C63]/10 text-foreground"
          : "border-border bg-muted text-foreground hover:bg-card"
      ].join(" ")}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-card text-[#145C63] shadow-sm shadow-slate-950/[0.03]">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="mb-1 inline-flex rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-muted-foreground">
          Step {step}
        </span>
        <span className="block text-sm font-black text-foreground">{action.title}</span>
        <span className="mt-1 block text-xs font-semibold leading-5 text-muted-foreground">{action.detail}</span>
      </span>
      <ArrowRight className="ml-auto mt-2 h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-[#145C63]" />
    </Link>
  );
}

const acronymGuide = [
  { term: "TEC", detail: "Telephone Enquiry Center: call intake without confirming passenger status." },
  { term: "NOK", detail: "Next of kin or family contact record." },
  { term: "PAX", detail: "Passenger or crew record from the manifest." },
  { term: "SRC", detail: "Source confirmation for passenger or crew information." },
  { term: "FAM", detail: "Family/NOK record used during matching." }
];

function AcronymGuide() {
  return (
    <div className="rounded-md border border-border bg-muted p-3">
      <h3 className="text-sm font-black text-foreground">Common shorthand</h3>
      <dl className="mt-3 grid gap-2">
        {acronymGuide.map((item) => (
          <div key={item.term} className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-2 text-xs">
            <dt className="font-black text-[#145C63]">{item.term}</dt>
            <dd className="font-semibold leading-5 text-muted-foreground">{item.detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

type AttentionKind = "request" | "match" | "family" | "enquiry";

type AttentionSummary = {
  title: string;
  href: string;
  status?: string;
  detail: string;
  context: string[];
  cta: string;
};

function text(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function firstText(row: AnyRecord, keys: string[]) {
  for (const key of keys) {
    const value = text(row[key]);
    if (value) return value;
  }
  return "";
}

function compactParts(values: unknown[], separator = " | ") {
  return values.map(text).filter(Boolean).join(separator);
}

function labelled(label: string, value: unknown) {
  const current = text(value);
  return current ? `${label}: ${current}` : "";
}

function recordFocus(row: AnyRecord) {
  return firstText(row, ["operationalId", "id", "caseId"]) || "record";
}

function attentionHref(kind: AttentionKind, row: AnyRecord) {
  const focus = encodeURIComponent(recordFocus(row));
  if (kind === "match") return `/matching?match=${focus}`;
  if (kind === "family") return `/family-nok?focus=${focus}`;
  if (kind === "enquiry") return `/tec-intake?focus=${focus}`;
  return `/requests?focus=${focus}`;
}

function attentionSummary(kind: AttentionKind, row: AnyRecord, cta: string): AttentionSummary {
  if (kind === "request") {
    const requester = firstText(row, ["requester", "enquiryCallerName", "callerName"]);
    return {
      title: compactParts([row.operationalId, requester]) || "Request",
      href: attentionHref(kind, row),
      status: firstText(row, ["priority", "status"]),
      detail: firstText(row, ["details", "category", "notes"]) || "Welfare request needs action.",
      context: [
        labelled("PAX", compactParts([row.passengerOperationalId, row.passengerName])),
        labelled("FAM", compactParts([row.familyOperationalId, row.familyName])),
        labelled("TEC", compactParts([row.enquiryOperationalId, row.enquiryCallerName])),
        labelled("Case", row.caseId)
      ].filter(Boolean),
      cta
    };
  }

  if (kind === "match") {
    return {
      title: compactParts([row.operationalId, compactParts([row.familyName, row.passengerName], " to ")]) || "Match",
      href: attentionHref(kind, row),
      status: firstText(row, ["holdCheck", "status"]),
      detail: firstText(row, ["decisionNotes", "matchBasis"]) || "Match needs review.",
      context: [
        labelled("PAX", compactParts([row.passengerOperationalId, row.passengerName])),
        labelled("FAM", compactParts([row.familyOperationalId, row.familyName])),
        labelled("TEC", compactParts([row.enquiryOperationalId, row.enquiryCallerName])),
        labelled("Claim", row.claimedRelationship),
        labelled("Case", row.caseId)
      ].filter(Boolean),
      cta
    };
  }

  if (kind === "family") {
    const familyName = firstText(row, ["familyName"]) || compactParts([row.lastName, row.firstName], ", ");
    return {
      title: compactParts([row.operationalId, familyName]) || "Family/NOK",
      href: attentionHref(kind, row),
      status: firstText(row, ["verificationStatus"]),
      detail: firstText(row, ["verificationNotes", "immediateNeeds", "claimedRelationship", "notes"]) || "Family/NOK record needs verification.",
      context: [
        labelled("Claim", row.claimedRelationship),
        labelled("PAX", compactParts([row.passengerOperationalId, row.passengerName])),
        labelled("Contact", compactParts([row.phone, row.email], " / ")),
        labelled("Case", row.caseId)
      ].filter(Boolean),
      cta
    };
  }

  return {
    title: compactParts([row.operationalId, firstText(row, ["enquiryCallerName", "callerName"])]) || "Enquiry",
    href: attentionHref(kind, row),
    status: firstText(row, ["urgency", "status"]),
    detail: firstText(row, ["notes", "claimedRelationship", "enquiryType"]) || "Enquiry is not linked to a match.",
    context: [
      labelled("Caller", firstText(row, ["enquiryCallerName", "callerName"])),
      labelled("PAX", compactParts([row.passengerOperationalId, row.passengerName])),
      labelled("Claim", row.claimedRelationship),
      labelled("Case", row.caseId)
    ].filter(Boolean),
    cta
  };
}

function AttentionItem({ row, kind, cta }: { row: AnyRecord; kind: AttentionKind; cta: string }) {
  const item = attentionSummary(kind, row, cta);
  return (
    <Link
      to={item.href}
      className="group grid gap-2 border-b border-border px-3 py-3 transition hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#145C63] last:border-0"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black text-foreground">{item.title}</p>
          <p className="mt-1 line-clamp-2 text-xs font-semibold text-muted-foreground">{item.detail}</p>
        </div>
        <StatusBadge value={item.status} className="max-w-[45%] shrink-0 sm:max-w-56" />
      </div>
      {item.context.length ? (
        <div className="flex flex-wrap gap-1.5">
          {item.context.slice(0, 4).map((value) => (
            <span key={value} className="inline-block max-w-full truncate rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
              {value}
            </span>
          ))}
        </div>
      ) : null}
      <span className="inline-flex items-center gap-1 text-xs font-black text-[#145C63] transition dark:text-[#7ed7dc]">
        {item.cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </Link>
  );
}

function AttentionBlock({
  title,
  icon: Icon,
  rows,
  kind,
  cta
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  rows?: AnyRecord[];
  kind: AttentionKind;
  cta: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card text-foreground">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-black text-foreground">{title}</h3>
      </div>
      {rows && rows.length > 0 ? (
        rows.slice(0, 4).map((row) => <AttentionItem key={row.id ?? row.operationalId} row={row} kind={kind} cta={cta} />)
      ) : (
        <div className="px-3 py-4 text-sm font-medium text-muted-foreground">Nothing needs action in this queue.</div>
      )}
    </div>
  );
}

export function DashboardPage({ portalUser, canAccessRoute }: { portalUser: DemoUser; canAccessRoute: (route: PortalRouteKey) => boolean }) {
  const { activeSession, reload } = useApp();
  const [dashboard, setDashboard] = useState<AnyRecord>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const onboardingStorageKey = `zpp:ui-tip:dashboard-start:v1:${portalUser.email}:${portalUser.role}`;
  const [showGettingStarted, setShowGettingStarted] = useState(() => localStorage.getItem(onboardingStorageKey) !== "dismissed");

  useEffect(() => {
    setShowGettingStarted(localStorage.getItem(onboardingStorageKey) !== "dismissed");
  }, [onboardingStorageKey]);

  function hideGettingStarted() {
    localStorage.setItem(onboardingStorageKey, "dismissed");
    setShowGettingStarted(false);
  }

  function showGettingStartedAgain() {
    localStorage.removeItem(onboardingStorageKey);
    setShowGettingStarted(true);
  }

  useEffect(() => {
    if (!activeSession) {
      setDashboard(undefined);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    api
      .dashboard(activeSession.id)
      .then(setDashboard)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [activeSession]);

  const manifest = dashboard?.manifestCoverage ?? {};
  const matching = dashboard?.matchingProgress ?? {};
  const work = dashboard?.workRemaining ?? {};
  const quality = dashboard?.dataQuality ?? {};
  const slices = (matching.slices ?? []) as DashboardSlice[];

  const expectedTotal = num(manifest.expectedTotal);
  const inDatabaseTotal = num(manifest.inDatabaseTotal);
  const reviewedTotal = num(manifest.reviewedTotal);
  const notReviewedTotal = num(manifest.notReviewedTotal);
  const manifestGapTotal = num(manifest.notLoadedTotal) + num(manifest.invalidTotal);
  const totalPax = num(matching.totalPax);
  const donePax = num(matching.done);
  const pendingMatchCount = num(work.pendingMatch);
  const activeHoldCount = num(work.activeHold);
  const urgentWelfareCount = num(work.urgentWelfare);
  const unverifiedFamilyCount = num(work.unverifiedFamily);
  const unlinkedEnquiryCount = num(work.unlinkedEnquiries);
  const attentionCount = activeHoldCount + urgentWelfareCount + pendingMatchCount + unverifiedFamilyCount + unlinkedEnquiryCount;
  const attentionDetail =
    [
      activeHoldCount ? `${activeHoldCount} holds` : "",
      urgentWelfareCount ? `${urgentWelfareCount} urgent` : "",
      pendingMatchCount ? `${pendingMatchCount} match review` : "",
      unverifiedFamilyCount ? `${unverifiedFamilyCount} family` : "",
      unlinkedEnquiryCount ? `${unlinkedEnquiryCount} unlinked` : ""
    ]
      .filter(Boolean)
      .join(" · ") || "clear";
  const allAttentionBlocks: Array<{
    title: string;
    icon: ComponentType<{ className?: string }>;
    rows: AnyRecord[];
    kind: AttentionKind;
    cta: string;
  }> = [
    { title: "Urgent welfare", icon: HeartPulse, rows: (dashboard?.priorityQueue?.urgentRequests ?? []) as AnyRecord[], kind: "request", cta: "Open request" },
    { title: "Unresolved holds", icon: ShieldAlert, rows: (dashboard?.priorityQueue?.unresolvedHolds ?? []) as AnyRecord[], kind: "match", cta: "Open match" },
    { title: "Pending matches", icon: Link2, rows: (dashboard?.priorityQueue?.pendingMatching ?? []) as AnyRecord[], kind: "match", cta: "Review match" },
    { title: "Unverified family/NOK", icon: AlertTriangle, rows: (dashboard?.priorityQueue?.unverifiedFamily ?? []) as AnyRecord[], kind: "family", cta: "Open family" },
    { title: "Unlinked enquiries", icon: Link2, rows: (dashboard?.priorityQueue?.unlinkedEnquiries ?? []) as AnyRecord[], kind: "enquiry", cta: "Open enquiry" }
  ];
  const attentionBlocks = allAttentionBlocks.filter((block) => block.rows.length > 0);
  const qualityItems = ([
    { label: "Missing case link", value: num(quality.missingCaseId), detail: "records without a usable case/passenger link", tone: "warning" },
    { label: "DOB / age missing", value: num(quality.missingDobOrAge), detail: "PAX or crew without age context", tone: "warning" },
    { label: "Seat missing", value: num(quality.missingSeat), detail: "passenger rows without seat assignment", tone: "warning" },
    { label: "SRC pending", value: num(quality.srcPending), detail: "loaded people not yet SRC-confirmed", tone: "warning" },
    { label: "Unknown condition", value: num(quality.unknownCondition), detail: "people without condition/status update", tone: "warning" },
    { label: "Family contact gaps", value: num(quality.familyContactMissing), detail: "family/NOK rows without phone or email", tone: "warning" },
    { label: "Open release actions", value: num(quality.openReleaseActions), detail: "prepared actions not completed or cancelled", tone: "warning" },
    { label: "Release checklist", value: num(quality.releaseChecklistPending), detail: "identity or hold checks still pending", tone: "warning" }
  ] satisfies QualityDashboardItem[]).filter((item) => item.value > 0);
  const qualityGapCount = qualityItems.reduce((sum, item) => sum + item.value, 0);
  const roleLabel = portalUser.roles.join(" + ");
  const userRoles = new Set(portalUser.roles);
  const isVolunteer = userRoles.has("ZPP Member");
  const isTec = userRoles.has("TEC Member") || userRoles.has("TEC Group Leader") || userRoles.has("TEC Coordinator");
  const isViewer = userRoles.has("Observer");
  const isAdmin = userRoles.has("System Admin");
  const configuredQuickActions: QuickActionItem[] = isVolunteer
    ? [
        { title: "Check my assignments", detail: "Start with tasks assigned to you or waiting to be claimed.", to: "/assignments", icon: ListTodo, primary: true },
        { title: "Review my roster", detail: "Confirm where you are expected and what function you support.", to: "/rostering", icon: CalendarDays },
        { title: "Open my training", detail: "Check required modules and due dates before taking tasks.", to: "/training", icon: BookOpenCheck },
        { title: "Read guidance", detail: "Use approved documents for procedures and handover notes.", to: "/documents", icon: FileText }
      ]
    : isTec
      ? [
          { title: "Open active briefing", detail: "Read the current event posture before handling calls.", to: "/active-event", icon: RadioTower, primary: true },
          { title: "Record TEC enquiry", detail: "Capture caller details without disclosing passenger status.", to: "/tec-intake", icon: PhoneCall },
          { title: "Review support requests", detail: "Track welfare or logistics requests linked to enquiries.", to: "/requests", icon: ClipboardList },
          { title: "Check timeline", detail: "Review recent operational notes and case events.", to: "/timeline", icon: ListTodo }
        ]
      : isViewer
        ? [
            { title: "Open active briefing", detail: "Start with the current event posture and latest updates.", to: "/active-event", icon: RadioTower, primary: true },
            { title: "Review roster coverage", detail: "See current coverage without changing assignments.", to: "/rostering", icon: CalendarDays },
            { title: "Read guidance", detail: "Open approved documents for the current response.", to: "/documents", icon: FileText },
            { title: "Check readiness", detail: "Review open gaps across training and availability.", to: "/readiness", icon: BookOpenCheck }
          ]
        : isAdmin
          ? [
              { title: "Review system settings", detail: "Check the current profile, sign-in and privacy configuration.", to: "/settings", icon: Database, primary: true },
              { title: "Review audit activity", detail: "Verify recent changes, actors and operational records.", to: "/audit", icon: ShieldAlert },
              { title: "Review documents", detail: "Check document status and restricted review items.", to: "/documents", icon: FileText },
              { title: "Open reports", detail: "Prepare an authorized briefing, handover or audit export.", to: "/reports", icon: PieChart }
            ]
          : [
            { title: "Open active briefing", detail: "Confirm the current posture, functions and coordination notes.", to: "/active-event", icon: RadioTower, primary: true },
            { title: "Review assignments", detail: "See owner, due time and status for operational tasks.", to: "/assignments", icon: ListTodo },
            { title: "Handle support requests", detail: "Prioritize welfare and logistics work that needs action.", to: "/requests", icon: ClipboardList },
            { title: "Review matching", detail: "Check family-to-passenger links, holds and verification status.", to: "/matching", icon: Link2 }
            ];
  const routeKeyByPath = new Map<string, PortalRouteKey>([
    ["/active-event", "active-event"],
    ["/assignments", "assignments"],
    ["/audit", "audit"],
    ["/documents", "documents"],
    ["/family-nok", "family-nok"],
    ["/matching", "matching"],
    ["/passenger-src", "passenger-src"],
    ["/readiness", "readiness"],
    ["/reports", "reports"],
    ["/requests", "requests"],
    ["/rostering", "rostering"],
    ["/settings", "settings"],
    ["/tec-intake", "tec-intake"],
    ["/timeline", "timeline"],
    ["/training", "training"]
  ]);
  const quickActions = configuredQuickActions.filter((action) => {
    const routeKey = routeKeyByPath.get(action.to);
    return routeKey ? canAccessRoute(routeKey) : false;
  });
  const manifestTarget = canAccessRoute("files-import") ? "/files-import" : canAccessRoute("passenger-src") ? "/passenger-src" : undefined;
  const processingTarget = canAccessRoute("passenger-src") ? "/passenger-src" : undefined;
  const matchingTarget = canAccessRoute("matching") ? "/matching" : undefined;

  if (loading) return <Loading label="Loading dashboard" />;
  if (error) {
    return (
      <EmptyState
        title="Dashboard unavailable"
        detail={error}
        action={<Button onClick={() => void reload()}>Retry operational context</Button>}
      />
    );
  }
  if (!activeSession) {
    return (
      <EmptyState
        title="No active session"
        detail={canAccessRoute("sessions") ? "Select or create an operational session before opening live work." : "Ask a coordinator to select an operational session, then retry."}
        action={
          canAccessRoute("sessions") ? (
            <Link className="focus-ring inline-flex h-9 items-center rounded-md bg-[#0B1F3A] px-3 text-sm font-bold text-white hover:bg-[#145C63]" to="/sessions">
              Open sessions
            </Link>
          ) : (
            <Button onClick={() => void reload()}>Retry operational context</Button>
          )
        }
      />
    );
  }
  if (!dashboard) return <EmptyState title="No dashboard data" action={<Button onClick={() => void reload()}>Retry</Button>} />;

  return (
    <div className="grid gap-5">
      {showGettingStarted ? (
        <Card>
          <CardHeader
            title="Start here: do these in order"
            description="If you are unsure, start with Step 1 and continue down the list until your own work is clear."
            action={
              <div className="flex items-center gap-2">
                <Badge tone="neutral">{roleLabel}</Badge>
                <Button icon={X} size="icon" variant="ghost" aria-label="Hide getting-started help" title="Hide getting-started help" onClick={hideGettingStarted} />
              </div>
            }
          />
          <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
            <section className="min-w-0">
              <h3 className="text-sm font-black text-foreground">Your next steps</h3>
              <p className="mt-1 text-sm font-semibold leading-6 text-muted-foreground">
                Do not search the whole system first. Open the first card, finish what it asks, then move to the next card only if needed.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {quickActions.map((action, index) => (
                  <QuickActionCard key={action.title} action={action} step={index + 1} />
                ))}
              </div>
            </section>
            <AcronymGuide />
          </div>
        </Card>
      ) : (
        <div className="flex justify-end">
          <Button icon={CircleHelp} size="sm" variant="ghost" onClick={showGettingStartedAgain}>
            Show getting-started help
          </Button>
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="Manifest" value={expectedTotal} detail={`${inDatabaseTotal} records loaded · ${manifestGapTotal} gaps`} icon={ClipboardList} tone={manifestGapTotal ? "warning" : "info"} to={manifestTarget} />
        <MetricTile label="Processing" value={`${reviewedTotal}/${inDatabaseTotal}`} detail={`${notReviewedTotal} not reviewed`} icon={Database} tone={notReviewedTotal ? "warning" : "success"} to={processingTarget} />
        <MetricTile label="Matching" value={`${donePax}/${totalPax}`} detail={`${num(matching.completionRate)}% verified or ready`} icon={PieChart} tone={donePax === totalPax && totalPax > 0 ? "success" : "info"} to={matchingTarget} />
        <MetricTile label="Needs attention" value={attentionCount} detail={attentionDetail} icon={AlertTriangle} tone={attentionCount ? "warning" : "success"} />
      </section>

      <Card>
        <CardHeader title="Operations Snapshot" />
        <div className="dashboard-progress-grid">
          <section className="grid min-w-0 gap-3 border-b border-border p-4 xl:border-b-0 xl:border-r xl:border-border">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-black text-foreground">Manifest coverage</h3>
              <Badge tone={manifestGapTotal ? "warning" : "success"}>{pct(inDatabaseTotal, expectedTotal)}% loaded</Badge>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <CompactStat label="PAX" value={num(manifest.passengersInDatabase)} detail="passenger records" icon={UsersRound} />
              <CompactStat label="Crew" value={num(manifest.crewInDatabase)} detail="crew records" icon={UserCheck} />
              {manifestGapTotal ? <CompactStat label="Import gaps" value={manifestGapTotal} detail={`${num(manifest.invalidTotal)} invalid rows`} icon={FileWarning} tone="warning" /> : null}
            </div>
          </section>

          <section className="grid min-w-0 content-start gap-3 p-4">
            <h3 className="text-sm font-black text-foreground">Matching progress</h3>
            <MatchingProgressSummary slices={slices} total={totalPax} complete={donePax} />
          </section>
        </div>
      </Card>

      <Card>
        <CardHeader title="Current Attention" action={attentionCount ? <Badge tone="warning">{attentionCount} items</Badge> : <Badge tone="success">Clear</Badge>} />
        {attentionBlocks.length ? (
          <div className="dashboard-attention-grid p-4">
            {attentionBlocks.map((block) => (
              <AttentionBlock key={block.title} title={block.title} icon={block.icon} rows={block.rows} kind={block.kind} cta={block.cta} />
            ))}
          </div>
        ) : (
          <div className="p-4">
            <EmptyState title="No current attention items" detail="Urgent queues are clear. Continue with assignments, roster, training or current briefing as appropriate for your role." />
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Data Quality" action={<Badge tone={qualityGapCount ? "warning" : "success"}>{qualityGapCount ? `${qualityGapCount} gaps` : "clear"}</Badge>} />
        {qualityItems.length ? (
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {qualityItems.map((item) => (
              <QualityItem key={item.label} {...item} />
            ))}
          </div>
        ) : (
          <div className="p-4">
            <EmptyState title="No data quality gaps" detail="Monitored checks are clear." />
          </div>
        )}
      </Card>
    </div>
  );
}
