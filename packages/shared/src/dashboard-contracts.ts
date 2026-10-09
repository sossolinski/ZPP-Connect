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
export type DashboardAttentionItem = { key: string; title: string; detail: string; href: string };
export type DashboardOperationalStatus = {
  loadedAt: string;
  specialist: DashboardAvailability<DashboardSpecialist>;
  attention: DashboardAvailability<{ items: DashboardAttentionItem[]; checkedSources: string[]; limitPerSource: number }>;
};
export type DashboardDto = { operationalStatus: DashboardOperationalStatus };
