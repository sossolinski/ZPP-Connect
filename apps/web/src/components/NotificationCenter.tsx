import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { AlertTriangle, Bell, CalendarCheck, CheckCheck, ClipboardList, FileText, GraduationCap, RadioTower, ShieldAlert, X } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";

type NotificationKind = "Action required" | "Information";
type NotificationSeverity = "Critical" | "Attention" | "Information";
type NotificationCategory = "Session" | "Briefing" | "Assignment" | "Rostering" | "Training" | "Documents" | "Readiness" | "Requests" | "Operational";

type NotificationItem = {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  category: NotificationCategory;
  title: string;
  message: string;
  sessionLabel?: string | null;
  sourceLabel?: string | null;
  createdAt: string;
  createdAtIso?: string;
  read: boolean;
  unread: boolean;
  active: boolean;
  resolved: boolean;
  requiresAction: boolean;
  actionDestination?: string | null;
  href?: string;
  actionLabel?: string | null;
};

type NotificationCounts = {
  unread: number;
  actionRequiredUnread: number;
  criticalUnread: number;
};

const severityRank: Record<NotificationSeverity, number> = {
  Critical: 0,
  Attention: 1,
  Information: 2
};

const categoryLabel: Record<NotificationCategory, string> = {
  Session: "Session",
  Briefing: "Briefing",
  Assignment: "Assignment",
  Rostering: "Roster",
  Training: "Training",
  Documents: "Documents",
  Readiness: "Readiness",
  Requests: "Requests",
  Operational: "Operational"
};

function formatTimestamp(value: string, iso?: string) {
  if (iso) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function severityClass(severity: NotificationSeverity, quiet = false) {
  if (severity === "Critical") return quiet ? "text-red-700 dark:text-red-200" : "border-red-200 bg-red-50 text-red-800 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-100";
  if (severity === "Attention") return quiet ? "text-amber-700 dark:text-amber-200" : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100";
  return quiet ? "text-[#145C63] dark:text-[#8ed5d7]" : "border-[#145C63]/25 bg-[#145C63]/10 text-[#145C63] dark:text-[#8ed5d7]";
}

function categoryIcon(category: NotificationCategory) {
  if (category === "Briefing" || category === "Operational") return RadioTower;
  if (category === "Assignment") return ClipboardList;
  if (category === "Rostering" || category === "Session") return CalendarCheck;
  if (category === "Training" || category === "Readiness") return GraduationCap;
  if (category === "Documents") return FileText;
  return ShieldAlert;
}

function sortNotifications(left: NotificationItem, right: NotificationItem) {
  return Number(right.unread) - Number(left.unread)
    || Number(right.active) - Number(left.active)
    || severityRank[left.severity] - severityRank[right.severity]
    || new Date(right.createdAtIso ?? right.createdAt).getTime() - new Date(left.createdAtIso ?? left.createdAt).getTime();
}

export function NotificationCenter({ role, canAccessTarget }: { role?: unknown; canAccessTarget: (href: string) => boolean }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [counts, setCounts] = useState<NotificationCounts>({ unread: 0, actionRequiredUnread: 0, criticalUnread: 0 });
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  const visibleItems = useMemo(() => [...items].sort(sortNotifications), [items]);
  const actionItems = visibleItems.filter((item) => item.kind === "Action required" && item.active);
  const updateItems = visibleItems.filter((item) => item.kind !== "Action required" || item.resolved);
  const allVisibleIds = useMemo(() => visibleItems.map((item) => item.id), [visibleItems]);
  const badgeCount = counts.unread;

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  async function refreshCounts() {
    try {
      const response = await api.notificationCounts<NotificationCounts>();
      setCounts(response);
    } catch {
      setCounts({ unread: 0, actionRequiredUnread: 0, criticalUnread: 0 });
    }
  }

  async function loadNotifications() {
    setBusy(true);
    try {
      const response = await api.notifications<NotificationItem>({ limit: 100 });
      setItems(response.data);
      setLoadError("");
      await refreshCounts();
    } catch {
      setItems([]);
      setLoadError("Unable to load notifications.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refreshCounts();
  }, [role]);

  useEffect(() => {
    if (open) void loadNotifications();
  }, [open, role]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  function applyItem(notification: NotificationItem) {
    setItems((current) => current.map((item) => (item.id === notification.id ? notification : item)));
  }

  function markRead(id: string) {
    void api.markNotificationRead<NotificationItem>(id).then((notification) => {
      applyItem(notification);
      setLoadError("");
      void refreshCounts();
    }).catch(() => setLoadError("Unable to update notification."));
  }

  function markUnread(id: string) {
    void api.markNotificationUnread<NotificationItem>(id).then((notification) => {
      applyItem(notification);
      setLoadError("");
      void refreshCounts();
    }).catch(() => setLoadError("Unable to update notification."));
  }

  function markAllRead() {
    setBusy(true);
    void api.markNotificationsRead<NotificationItem>(allVisibleIds).then((response) => {
      setItems(response.data);
      setLoadError("");
      void refreshCounts();
    }).catch(() => setLoadError("Unable to update notifications.")).finally(() => setBusy(false));
  }

  function notificationRow(item: NotificationItem) {
    const Icon = categoryIcon(item.category);
    const destination = item.actionDestination ?? item.href ?? null;
    const canOpen = Boolean(destination && canAccessTarget(destination));

    return (
      <article key={item.id} className={clsx("flex gap-3 px-3 py-3", item.read && "opacity-80")}>
        <div className={clsx("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border", severityClass(item.severity))}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className={clsx("rounded-full border px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide", severityClass(item.severity))}>
              {item.kind === "Action required" && item.active ? "Action" : item.resolved ? "Resolved" : "Update"}
            </span>
            <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
              {categoryLabel[item.category]}
            </span>
            {item.sessionLabel ? (
              <span className="rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                {item.sessionLabel}
              </span>
            ) : null}
            {!item.read ? <span className="h-2 w-2 rounded-full bg-amber-400" aria-label="Unread" /> : null}
          </div>
          <h3 className="mt-1 text-sm font-black leading-5 text-foreground">{item.title}</h3>
          <p className="mt-1 text-xs font-semibold leading-5 text-muted-foreground">{item.message}</p>
          <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="truncate text-[11px] font-semibold text-muted-foreground">{formatTimestamp(item.createdAt, item.createdAtIso)}</span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className="focus-ring rounded px-1.5 py-1 text-[11px] font-black text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => (item.read ? markUnread(item.id) : markRead(item.id))}
              >
                {item.read ? "Mark unread" : "Mark read"}
              </button>
              {canOpen && destination ? (
                <Link
                  to={destination}
                  className={clsx("focus-ring rounded px-1.5 py-1 text-xs font-black", severityClass(item.severity, true))}
                  onClick={() => markRead(item.id)}
                >
                  {item.actionLabel ?? "Open"}
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </article>
    );
  }

  return (
    <div className="relative block">
      <button
        type="button"
        className="focus-ring relative flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-white/10 text-white/75 hover:bg-white/[0.15] hover:text-white"
        aria-label={badgeCount ? `${badgeCount} unread notifications` : "Notifications"}
        aria-expanded={open}
        title="Notifications"
        onClick={() => setOpen((current) => !current)}
      >
        <Bell className="h-4 w-4" />
        {badgeCount ? (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-[#071A32] bg-amber-400 px-1 text-[10px] font-black leading-none text-[#071A32]">
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <button type="button" className="fixed inset-0 z-[80] cursor-default" aria-label="Close notifications" onClick={() => setOpen(false)} />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Notification center"
            className="fixed right-2 top-[7.25rem] z-[90] flex max-h-[calc(100vh-8rem)] w-[min(25rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-2xl sm:right-5 sm:top-[6rem] sm:max-h-[calc(100vh-7rem)] lg:top-14 lg:max-h-[min(34rem,calc(100vh-6rem))]"
          >
            <div className="border-b border-border px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-black text-foreground">Notifications</h2>
                  <p className="mt-0.5 text-[11px] font-semibold text-muted-foreground">Start with action items, then review updates.</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className="focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-xs font-bold text-muted-foreground hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!allVisibleIds.length || busy}
                    onClick={markAllRead}
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                    Mark read
                  </button>
                  <button
                    type="button"
                    className="focus-ring flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Close notifications"
                    onClick={() => setOpen(false)}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="scrollbar-soft min-h-0 flex-1 overflow-y-auto">
              {loadError ? (
                <div className="p-4">
                  <div className="rounded-md border border-dashed border-border bg-muted px-4 py-6 text-center">
                    <AlertTriangle className="mx-auto h-5 w-5 text-muted-foreground" />
                    <p className="mt-2 text-sm font-black text-foreground">{loadError}</p>
                    <button type="button" className="focus-ring mt-3 rounded-md border border-border bg-card px-3 py-2 text-xs font-black text-foreground hover:bg-muted" onClick={loadNotifications}>
                      Retry
                    </button>
                  </div>
                </div>
              ) : visibleItems.length ? (
                <div className="grid">
                  <section className="border-b border-border">
                    <div className="flex items-center justify-between gap-3 bg-muted px-3 py-2">
                      <h3 className="text-xs font-black uppercase tracking-wide text-muted-foreground">Action required</h3>
                      <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-black text-muted-foreground">{actionItems.length}</span>
                    </div>
                    {actionItems.length ? <div className="grid divide-y divide-border">{actionItems.map(notificationRow)}</div> : (
                      <p className="px-3 py-4 text-sm font-semibold text-muted-foreground">No action required.</p>
                    )}
                  </section>
                  <section>
                    <div className="flex items-center justify-between gap-3 bg-muted px-3 py-2">
                      <h3 className="text-xs font-black uppercase tracking-wide text-muted-foreground">Updates</h3>
                      <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-black text-muted-foreground">{updateItems.length}</span>
                    </div>
                    {updateItems.length ? <div className="grid divide-y divide-border">{updateItems.map(notificationRow)}</div> : (
                      <p className="px-3 py-4 text-sm font-semibold text-muted-foreground">No updates.</p>
                    )}
                  </section>
                </div>
              ) : (
                <div className="p-4">
                  <div className="rounded-md border border-dashed border-border bg-muted px-4 py-6 text-center">
                    <Bell className="mx-auto h-5 w-5 text-muted-foreground" />
                    <p className="mt-2 text-sm font-black text-foreground">{busy ? "Loading notifications..." : "No notifications"}</p>
                    <p className="mt-1 text-xs font-semibold leading-5 text-muted-foreground">Action items and updates will appear here when they apply to you.</p>
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
