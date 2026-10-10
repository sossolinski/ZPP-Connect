/** Clock comparisons use epoch time; callers supply now for deterministic checks. */
export function ageLabel(timestamp: string, now: number): string {
  const age = Math.max(0, now - Date.parse(timestamp));
  if (!Number.isFinite(age)) return "time unknown";
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
export function briefingUpdateState(nextUpdateDueAt: string | null | undefined, now: number): "overdue" | "scheduled" | "unscheduled" {
  return !nextUpdateDueAt ? "unscheduled" : Date.parse(nextUpdateDueAt) < now ? "overdue" : "scheduled";
}
export const dashboardStaleAfterMs = 5 * 60_000;
