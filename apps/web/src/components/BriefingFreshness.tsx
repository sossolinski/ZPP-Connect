import { ageLabel, briefingUpdateState } from "@zpp/shared";
import { useOperationalClock } from "../lib/use-operational-clock";
import { formatDate } from "../lib/format";

export function BriefingFreshness({ publishedAt, nextUpdateDueAt }: { publishedAt: string | null; nextUpdateDueAt: string | null }) {
  const now = useOperationalClock();
  const state = briefingUpdateState(nextUpdateDueAt, now);
  return <div role="status" data-testid="briefing-freshness" className={`mt-3 rounded-md border p-3 text-sm font-semibold ${state === "overdue" ? "border-amber-500 bg-amber-50 text-amber-950" : "border-border"}`}>
    <p>{publishedAt ? `Published ${ageLabel(publishedAt, now)} · ${formatDate(publishedAt)}` : "Publication time unavailable"}</p>
    <p>{state === "overdue" ? "Update overdue · " : ""}{nextUpdateDueAt ? `Next update due ${formatDate(nextUpdateDueAt)}` : "No next update scheduled"}</p>
  </div>;
}
