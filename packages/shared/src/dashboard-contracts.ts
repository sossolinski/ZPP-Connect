/** PI1 read boundary. Absence and failed loads are never measured zero. */
export type DashboardAvailability<T> = { status: "available"; value: T } | { status: "unavailable" };
export type DashboardSlice = { key: string; label: string; value: number; tone: "success" | "info" | "warning" | "neutral" | "danger"; color: string };
export type DashboardSpecialist = {
  manifestCoverage: {
    expectedTotal: number; inDatabaseTotal: number; notLoadedTotal: number; invalidTotal: number;
    reviewedTotal: number; notReviewedTotal: number; passengersInDatabase: number;
    crewInDatabase: number; unknownTypeInDatabase: number; sourceBreakdown: Array<{ label: string; value: number }>;
  };
  matchingProgress: {
    totalPax: number; done: number; inReview: number; onHold: number; noCandidate: number;
    rejectedOnly: number; completionRate: number; slices: DashboardSlice[];
  };
  dataQuality: {
    missingCaseId: number; missingDobOrAge: number; missingSeat: number; srcPending: number;
    unknownCondition: number; familyContactMissing: number; openReleaseActions: number; releaseChecklistPending: number;
  };
};
export type DashboardAttentionItem = { key: string; title: string; detail: string; href: string; actionLabel?: string };
export type DashboardOperationalStatus = {
  loadedAt: string;
  specialist: DashboardAvailability<DashboardSpecialist>;
  attention: DashboardAvailability<{ items: DashboardAttentionItem[]; checkedSources: string[]; limitPerSource: number }>;
};
export type DashboardDto = { operationalStatus: DashboardOperationalStatus; workspace?: import("./incident-workspace.js").IncidentWorkspace };

/** Reject incomplete/malformed responses at this touched boundary, never invent zero. */
export function assertDashboardDto(input: unknown): asserts input is DashboardDto {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dashboard status could not be verified. Retry.");
    return value as Record<string, unknown>;
  };
  const fail = () => { throw new Error("Dashboard status could not be verified. Retry."); };
  const status = record(record(input).operationalStatus);
  if (typeof status.loadedAt !== "string" || !Number.isFinite(Date.parse(status.loadedAt))) fail();
  const specialist = record(status.specialist);
  if (specialist.status === "available") {
    const value = record(specialist.value);
    for (const [section, fields] of [
      ["manifestCoverage", ["expectedTotal", "inDatabaseTotal", "notLoadedTotal", "invalidTotal", "reviewedTotal", "notReviewedTotal", "passengersInDatabase", "crewInDatabase", "unknownTypeInDatabase"]],
      ["matchingProgress", ["totalPax", "done", "inReview", "onHold", "noCandidate", "rejectedOnly", "completionRate"]],
      ["dataQuality", ["missingCaseId", "missingDobOrAge", "missingSeat", "srcPending", "unknownCondition", "familyContactMissing", "openReleaseActions", "releaseChecklistPending"]],
    ] as const) {
      const metrics = record(value[section]);
      for (const field of fields) if (typeof metrics[field] !== "number" || !Number.isFinite(metrics[field]) || Number(metrics[field]) < 0) fail();
    }
    const slices = record(value.matchingProgress).slices;
    if (!Array.isArray(slices)) fail();
    for (const slice of slices as unknown[]) {
      const row = record(slice);
      if (typeof row.value !== "number" || !Number.isFinite(row.value) || typeof row.key !== "string" || typeof row.label !== "string" || typeof row.color !== "string") fail();
    }
  } else if (specialist.status !== "unavailable" || "value" in specialist) fail();
  const attention = record(status.attention);
  if (attention.status === "available") {
    const value = record(attention.value);
    if (!Array.isArray(value.items) || !Array.isArray(value.checkedSources) || !value.checkedSources.length || !value.checkedSources.every(item => typeof item === "string") || value.limitPerSource !== 5) fail();
    for (const item of value.items as unknown[]) {
      const row = record(item);
      if (row.actionLabel !== undefined && typeof row.actionLabel !== "string") fail();
      if (![row.key, row.title, row.detail, row.href].every(field => typeof field === "string") || !String(row.href).startsWith("/") || String(row.href).startsWith("//")) fail();
    }
  } else if (attention.status !== "unavailable" || "value" in attention) fail();
}
