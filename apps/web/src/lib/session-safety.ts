import type { SessionRecord } from "./types";

const nonWritableSessionStatuses = new Set(["closed", "archived"]);

export function isSessionWritable(session?: SessionRecord) {
  return Boolean(session && !nonWritableSessionStatuses.has(String(session.status ?? "").trim().toLowerCase()));
}

export function isSessionWriteContextCurrent(session: SessionRecord | undefined, expectedSessionId?: string | null) {
  return isSessionWritable(session) && (!expectedSessionId || session?.id === expectedSessionId);
}

function sessionTimestamp(session: SessionRecord) {
  const value = session.updatedAt ?? session.createdAt ?? session.startAt;
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function mostRecentWritableSession(sessions: SessionRecord[]) {
  return [...sessions]
    .filter(isSessionWritable)
    .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left) || right.operationalId.localeCompare(left.operationalId))[0];
}
