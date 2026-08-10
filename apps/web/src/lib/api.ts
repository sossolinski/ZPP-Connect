import type { ApiList, AnyRecord, AppOrganization, AppProfile, DictionaryMap, SessionRecord, UserContext } from "./types";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";
export const API_PAGE_LIMIT = 200;
const API_LIST_ALL_MAX_RECORDS = 5000;
const API_SESSION_TOKEN_KEY = "zpp:sessionToken";

export type AuthenticationPolicy = "SSO_ONLY" | "PASSWORD_ONLY" | "SSO_OR_PASSWORD";
export type ProductAuthenticationMethod = "MICROSOFT_SSO" | "EMAIL_PASSWORD";

export type AuthenticationDiscovery = {
  accountEligible: boolean;
  authenticationPolicy?: AuthenticationPolicy;
  permittedMethods: ProductAuthenticationMethod[];
  message: string;
};

export type DevelopmentAuthUser = {
  userId: string;
  displayName: string;
  email: string;
  authenticationPolicy: AuthenticationPolicy;
  permittedMethods: ProductAuthenticationMethod[];
};

export type DevelopmentLoginResult = {
  session: {
    id: string;
    token: string;
    userId: string;
    authenticationMethod: string;
    createdAt: string;
  };
  user: UserContext;
};

type ListAllOptions = {
  pageLimit?: number;
  maxRecords?: number;
};

let currentSessionToken = localStorage.getItem(API_SESSION_TOKEN_KEY) ?? "";

export class ApiRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export function setApiSession(token: string) {
  currentSessionToken = token;
  if (token) localStorage.setItem(API_SESSION_TOKEN_KEY, token);
  else localStorage.removeItem(API_SESSION_TOKEN_KEY);
}

export function clearApiSession() {
  setApiSession("");
}

export function getApiSession() {
  return currentSessionToken;
}

function authHeaders(extra?: HeadersInit, skipAuth = false) {
  return {
    ...(!skipAuth && currentSessionToken ? { Authorization: `Bearer ${currentSessionToken}` } : {}),
    ...extra
  };
}

function headers(extra?: HeadersInit, skipAuth = false) {
  return {
    "content-type": "application/json",
    ...authHeaders(extra, skipAuth)
  };
}

function queryString(query?: Record<string, string | number | boolean | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}

async function request<T>(path: string, init?: RequestInit & { skipAuth?: boolean }): Promise<T> {
  const { skipAuth, ...requestInit } = init ?? {};
  const response = await fetch(`${API_URL}${path}`, {
    ...requestInit,
    headers: requestInit.body instanceof FormData ? authHeaders(requestInit.headers, skipAuth) : headers(requestInit.headers, skipAuth)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiRequestError(error.error ?? response.statusText, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function listAllPages<T>(
  loadPage: (query: AnyRecord) => Promise<ApiList<T>>,
  query?: AnyRecord,
  options?: ListAllOptions
): Promise<ApiList<T>> {
  const pageLimit = Math.min(Math.max(Math.trunc(options?.pageLimit ?? API_PAGE_LIMIT), 1), API_PAGE_LIMIT);
  const maxRecords = Math.max(Math.trunc(options?.maxRecords ?? API_LIST_ALL_MAX_RECORDS), pageLimit);
  const { limit: _limit, offset: initialOffset, ...baseQuery } = query ?? {};
  const data: T[] = [];
  let offset = Number.isFinite(Number(initialOffset)) ? Math.max(0, Math.trunc(Number(initialOffset))) : 0;
  let total: number | undefined;
  let listMetadata: Record<string, unknown> = {};

  while (data.length < maxRecords) {
    const page = await loadPage({ ...baseQuery, limit: pageLimit, offset });
    if (offset === Number(initialOffset ?? 0) || data.length === 0) {
      const { data: _data, total: _total, limit: _pageLimit, offset: _pageOffset, ...metadata } = page as ApiList<T> & Record<string, unknown>;
      listMetadata = metadata;
    }
    data.push(...page.data);
    if (typeof page.total === "number") total = page.total;
    if (page.data.length < pageLimit || (total !== undefined && offset + page.data.length >= total)) break;
    offset += page.data.length;
  }

  return { total: total ?? data.length, data, ...listMetadata };
}

export const api = {
  authConfig: () => request<{ developmentAccessEnabled: boolean }>("/auth/config", { skipAuth: true }),
  authDiscovery: (identifier: string) =>
    request<AuthenticationDiscovery>("/auth/discovery", {
      method: "POST",
      body: JSON.stringify({ identifier }),
      skipAuth: true
    }),
  developmentUsers: () => request<ApiList<DevelopmentAuthUser>>("/auth/development/users", { skipAuth: true }),
  developmentLogin: async (body: { userId: string; method: ProductAuthenticationMethod }) => {
    const result = await request<DevelopmentLoginResult>("/auth/development/login", {
      method: "POST",
      body: JSON.stringify(body),
      skipAuth: true
    });
    setApiSession(result.session.token);
    return result;
  },
  logout: async () => {
    try {
      await request<void>("/auth/logout", { method: "POST", body: JSON.stringify({}) });
    } finally {
      clearApiSession();
    }
  },
  me: () => request<{ user: UserContext }>("/auth/me"),
  profile: () => request<AppProfile>("/config/profile"),
  dictionaries: () => request<DictionaryMap>("/dictionaries"),
  dashboard: (sessionId?: string) => request<AnyRecord>(`/dashboard${queryString({ sessionId })}`),
  sessions: (query?: AnyRecord) => request<ApiList<SessionRecord>>(`/sessions${queryString(query)}`),
  sessionsAll: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<SessionRecord>((pageQuery) => request<ApiList<SessionRecord>>(`/sessions${queryString(pageQuery)}`), query, options),
  createSession: (body: AnyRecord) => request<SessionRecord>("/sessions", { method: "POST", body: JSON.stringify(body) }),
  updateSession: (id: string, body: AnyRecord) => request<SessionRecord>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  closeSession: (id: string, notes?: string) => request<SessionRecord>(`/sessions/${id}/close`, { method: "POST", body: JSON.stringify({ notes }) }),
  list: <T = AnyRecord>(resource: string, query?: AnyRecord) => request<ApiList<T>>(`/${resource}${queryString(query)}`),
  listAll: <T = AnyRecord>(resource: string, query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<T>((pageQuery) => request<ApiList<T>>(`/${resource}${queryString(pageQuery)}`), query, options),
  record: <T = AnyRecord>(resource: string, id: string, query?: AnyRecord) => request<T>(`/${resource}/${id}${queryString(query)}`),
  create: <T = AnyRecord>(resource: string, body: AnyRecord) => request<T>(`/${resource}`, { method: "POST", body: JSON.stringify(body) }),
  update: <T = AnyRecord>(resource: string, id: string, body: AnyRecord) => request<T>(`/${resource}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  remove: <T = AnyRecord>(path: string) => request<T>(path, { method: "DELETE" }),
  action: <T = AnyRecord>(resource: string, id: string, action: string, body?: AnyRecord) =>
    request<T>(`/${resource}/${id}/${action}`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  memberProfiles: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/member-profiles${queryString(pageQuery)}`), query, options),
  memberProfilesPage: (query?: AnyRecord) => request<ApiList<AnyRecord>>(`/member-profiles${queryString(query)}`),
  memberProfile: (id: string) => request<AnyRecord>(`/member-profiles/${id}`),
  createMemberProfile: (body: AnyRecord) => request<AnyRecord>("/member-profiles", { method: "POST", body: JSON.stringify(body) }),
  updateMemberProfile: (id: string, body: AnyRecord) => request<AnyRecord>(`/member-profiles/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveMemberProfile: (id: string, body: AnyRecord = {}) => request<AnyRecord>(`/member-profiles/${id}/archive`, { method: "POST", body: JSON.stringify(body) }),
  restoreMemberProfile: (id: string, body: AnyRecord = {}) => request<AnyRecord>(`/member-profiles/${id}/restore`, { method: "POST", body: JSON.stringify(body) }),
  memberProfileUserLinks: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/member-profile-user-links${queryString(pageQuery)}`), query, options),
  groups: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/groups${queryString(pageQuery)}`), query, options),
  groupsPage: (query?: AnyRecord) => request<ApiList<AnyRecord>>(`/groups${queryString(query)}`),
  group: (id: string, query?: AnyRecord) => request<AnyRecord>(`/groups/${id}${queryString(query)}`),
  createGroup: (body: AnyRecord) => request<AnyRecord>("/groups", { method: "POST", body: JSON.stringify(body) }),
  updateGroup: (id: string, body: AnyRecord) => request<AnyRecord>(`/groups/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveGroup: (id: string, body: AnyRecord = {}) => request<AnyRecord>(`/groups/${id}/archive`, { method: "POST", body: JSON.stringify(body) }),
  groupMembers: (id: string, query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/groups/${id}/members${queryString(pageQuery)}`), query, options),
  groupMembersPage: (id: string, query?: AnyRecord) => request<ApiList<AnyRecord>>(`/groups/${id}/members${queryString(query)}`),
  addGroupMember: (id: string, body: AnyRecord) => request<AnyRecord>(`/groups/${id}/members`, { method: "POST", body: JSON.stringify(body) }),
  updateGroupMember: (id: string, memberProfileId: string, body: AnyRecord) =>
    request<AnyRecord>(`/groups/${id}/members/${memberProfileId}`, { method: "PATCH", body: JSON.stringify(body) }),
  removeGroupMember: (id: string, memberProfileId: string, body: AnyRecord = {}) => request<AnyRecord>(`/groups/${id}/members/${memberProfileId}`, { method: "DELETE", body: JSON.stringify(body) }),
  setGroupLeader: (id: string, body: AnyRecord) => request<AnyRecord>(`/groups/${id}/set-leader`, { method: "POST", body: JSON.stringify(body) }),
  rosterShifts: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/roster-shifts${queryString(pageQuery)}`), query, options),
  rosterShiftsPage: (query?: AnyRecord) => request<ApiList<AnyRecord>>(`/roster-shifts${queryString(query)}`),
  rosterShift: (id: string, query?: AnyRecord) => request<AnyRecord>(`/roster-shifts/${id}${queryString(query)}`),
  createRosterShift: (body: AnyRecord) => request<AnyRecord>("/roster-shifts", { method: "POST", body: JSON.stringify(body) }),
  updateRosterShift: (id: string, body: AnyRecord) => request<AnyRecord>(`/roster-shifts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  publishRosterShift: (id: string, body?: AnyRecord) => request<AnyRecord>(`/roster-shifts/${id}/publish`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  confirmRosterShift: (id: string, body?: AnyRecord) => request<AnyRecord>(`/roster-shifts/${id}/confirm`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  declineRosterShift: (id: string, body?: AnyRecord) => request<AnyRecord>(`/roster-shifts/${id}/decline`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  cancelRosterShift: (id: string, body?: AnyRecord) => request<AnyRecord>(`/roster-shifts/${id}/cancel`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  completeRosterShift: (id: string, body?: AnyRecord) => request<AnyRecord>(`/roster-shifts/${id}/complete`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  availability: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/availability${queryString(pageQuery)}`), query, options),
  availabilityPage: (query?: AnyRecord) => request<ApiList<AnyRecord>>(`/availability${queryString(query)}`),
  createAvailability: (body: AnyRecord) => request<AnyRecord>("/availability", { method: "POST", body: JSON.stringify(body) }),
  updateAvailability: (id: string, body: AnyRecord) => request<AnyRecord>(`/availability/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  removeAvailability: (id: string, body: AnyRecord = {}) => request<AnyRecord>(`/availability/${id}/remove`, { method: "POST", body: JSON.stringify(body) }),
  trainingCourses: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/training/courses${queryString(pageQuery)}`), query, options),
  trainingCoursesPage: (query?: AnyRecord) => request<ApiList<AnyRecord>>(`/training/courses${queryString(query)}`),
  trainingCourse: (id: string) => request<AnyRecord>(`/training/courses/${id}`),
  createTrainingCourse: (body: AnyRecord) => request<AnyRecord>("/training/courses", { method: "POST", body: JSON.stringify(body) }),
  updateTrainingCourse: (id: string, body: AnyRecord) => request<AnyRecord>(`/training/courses/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deactivateTrainingCourse: (id: string, body?: AnyRecord) => request<AnyRecord>(`/training/courses/${id}/deactivate`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  reactivateTrainingCourse: (id: string, body?: AnyRecord) => request<AnyRecord>(`/training/courses/${id}/reactivate`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  trainingRequirements: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/training/requirements${queryString(pageQuery)}`), query, options),
  trainingRequirementsPage: (query?: AnyRecord) => request<ApiList<AnyRecord>>(`/training/requirements${queryString(query)}`),
  trainingRequirement: (id: string) => request<AnyRecord>(`/training/requirements/${id}`),
  createTrainingRequirement: (body: AnyRecord) => request<AnyRecord>("/training/requirements", { method: "POST", body: JSON.stringify(body) }),
  updateTrainingRequirement: (id: string, body: AnyRecord) => request<AnyRecord>(`/training/requirements/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  endTrainingRequirement: (id: string, body?: AnyRecord) => request<AnyRecord>(`/training/requirements/${id}/end`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  trainingRecords: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/training/records${queryString(pageQuery)}`), query, options),
  trainingRecordsPage: (query?: AnyRecord) => request<ApiList<AnyRecord>>(`/training/records${queryString(query)}`),
  trainingRecord: (id: string) => request<AnyRecord>(`/training/records/${id}`),
  assignTrainingRecord: (body: AnyRecord) => request<AnyRecord>("/training/records/assign", { method: "POST", body: JSON.stringify(body) }),
  updateTrainingRecord: (id: string, body: AnyRecord) => request<AnyRecord>(`/training/records/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  startTrainingRecord: (id: string, body?: AnyRecord) => request<AnyRecord>(`/training/records/${id}/start`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  completeTrainingRecord: (id: string, body: AnyRecord) => request<AnyRecord>(`/training/records/${id}/complete`, { method: "POST", body: JSON.stringify(body) }),
  verifyTrainingRecord: (id: string, body?: AnyRecord) => request<AnyRecord>(`/training/records/${id}/verify`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  waiveTrainingRecord: (id: string, body: AnyRecord) => request<AnyRecord>(`/training/records/${id}/waive`, { method: "POST", body: JSON.stringify(body) }),
  cancelTrainingRecord: (id: string, body: AnyRecord) => request<AnyRecord>(`/training/records/${id}/cancel`, { method: "POST", body: JSON.stringify(body) }),
  documents: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/documents${queryString(pageQuery)}`), query, options),
  document: (id: string) => request<AnyRecord>(`/documents/${id}`),
  createDocument: (body: AnyRecord) => request<AnyRecord>("/documents", { method: "POST", body: JSON.stringify(body) }),
  updateDocument: (id: string, body: AnyRecord) => request<AnyRecord>(`/documents/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveDocument: (id: string, body?: AnyRecord) => request<AnyRecord>(`/documents/${id}/archive`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  reactivateDocument: (id: string, body?: AnyRecord) => request<AnyRecord>(`/documents/${id}/reactivate`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  documentVersions: (documentId: string, query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/documents/${documentId}/versions${queryString(pageQuery)}`), query, options),
  documentVersion: (id: string) => request<AnyRecord>(`/document-versions/${id}`),
  createDocumentVersion: (documentId: string, body: AnyRecord) => request<AnyRecord>(`/documents/${documentId}/versions`, { method: "POST", body: JSON.stringify(body) }),
  updateDocumentVersion: (id: string, body: AnyRecord) => request<AnyRecord>(`/document-versions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  publishDocumentVersion: (id: string, body?: AnyRecord) => request<AnyRecord>(`/document-versions/${id}/publish`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  withdrawDocumentVersion: (id: string, body?: AnyRecord) => request<AnyRecord>(`/document-versions/${id}/withdraw`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  documentVersionContent: (id: string) => request<AnyRecord>(`/document-versions/${id}/content`),
  documentRequirements: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/document-requirements${queryString(pageQuery)}`), query, options),
  documentRequirement: (id: string) => request<AnyRecord>(`/document-requirements/${id}`),
  createDocumentRequirement: (body: AnyRecord) => request<AnyRecord>("/document-requirements", { method: "POST", body: JSON.stringify(body) }),
  updateDocumentRequirement: (id: string, body: AnyRecord) => request<AnyRecord>(`/document-requirements/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  endDocumentRequirement: (id: string, body?: AnyRecord) => request<AnyRecord>(`/document-requirements/${id}/end`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  documentAcknowledgements: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/document-acknowledgements${queryString(pageQuery)}`), query, options),
  acknowledgeDocumentVersion: (id: string, body?: AnyRecord) => request<AnyRecord>(`/document-versions/${id}/acknowledge`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  readinessMe: (query?: AnyRecord) => request<AnyRecord>(`/readiness/me${queryString(query)}`),
  readinessMembers: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/readiness/members${queryString(pageQuery)}`), query, options),
  readinessMember: (id: string, query?: AnyRecord) => request<AnyRecord>(`/readiness/members/${id}${queryString(query)}`),
  readinessGroups: (query?: AnyRecord, options?: ListAllOptions) =>
    listAllPages<AnyRecord>((pageQuery) => request<ApiList<AnyRecord>>(`/readiness/groups${queryString(pageQuery)}`), query, options),
  readinessGroup: (id: string, query?: AnyRecord) => request<AnyRecord>(`/readiness/groups/${id}${queryString(query)}`),
  readinessSummary: (query?: AnyRecord) => request<AnyRecord>(`/readiness/summary${queryString(query)}`),
  activeEvent: (sessionId: string) => request<AnyRecord>(`/sessions/${sessionId}/active-event`),
  briefingHistory: (sessionId: string) => request<ApiList<AnyRecord>>(`/sessions/${sessionId}/briefings`),
  currentBriefing: (sessionId: string) => request<AnyRecord>(`/sessions/${sessionId}/briefings/current`),
  briefing: (id: string) => request<AnyRecord>(`/briefings/${id}`),
  createBriefingDraft: (sessionId: string) => request<AnyRecord>(`/sessions/${sessionId}/briefings/draft`, { method: "POST", body: JSON.stringify({}) }),
  updateBriefingDraft: (id: string, body: AnyRecord) => request<AnyRecord>(`/briefings/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  publishBriefingDraft: (id: string, expectedVersion: number) => request<AnyRecord>(`/briefings/${id}/publish`, { method: "POST", body: JSON.stringify({ expectedVersion }) }),
  assignmentQueue: <T = AnyRecord>(query: AnyRecord) => request<ApiList<T>>(`/assignments/queue${queryString(query)}`),
  assignment: <T = AnyRecord>(id: string, sessionId: string) => request<T>(`/assignments/${id}${queryString({ sessionId })}`),
  assignmentAssignees: (query: AnyRecord) => request<ApiList<AnyRecord>>(`/assignments/assignees${queryString(query)}`),
  notifications: <T = AnyRecord>(query?: AnyRecord) => request<ApiList<T>>(`/notifications${queryString(query)}`),
  notification: <T = AnyRecord>(id: string) => request<T>(`/notifications/${id}`),
  notificationCounts: <T = AnyRecord>() => request<T>("/notifications/counts"),
  markNotificationRead: <T = AnyRecord>(id: string) => request<T>(`/notifications/${id}/read`, { method: "POST", body: JSON.stringify({}) }),
  markNotificationUnread: <T = AnyRecord>(id: string) => request<T>(`/notifications/${id}/unread`, { method: "POST", body: JSON.stringify({}) }),
  markNotificationsRead: <T = AnyRecord>(ids?: string[]) =>
    request<ApiList<T>>("/notifications/read-all", { method: "POST", body: JSON.stringify({ ids }) }),
  matchingQueue: (query: AnyRecord) => request<ApiList<AnyRecord>>(`/matching/queue${queryString(query)}`),
  matchingContext: (claimId: string, sessionId: string) => request<AnyRecord>(`/matching/claims/${claimId}${queryString({ sessionId })}`),
  matchingSuggestions: (claimId: string, query: AnyRecord) => request<ApiList<AnyRecord>>(`/matching/claims/${claimId}/suggestions${queryString(query)}`),
  generateMatchingSuggestions: (claimId: string, body: AnyRecord) =>
    request<ApiList<AnyRecord>>(`/matching/claims/${claimId}/suggestions/generate`, { method: "POST", body: JSON.stringify(body) }),
  matchingCandidates: (claimId: string, query: AnyRecord) => request<ApiList<AnyRecord>>(`/matching/claims/${claimId}/candidates${queryString(query)}`),
  confirmMatching: (claimId: string, body: AnyRecord) =>
    request<AnyRecord>(`/matching/claims/${claimId}/confirm`, { method: "POST", body: JSON.stringify(body) }),
  rejectMatchingSuggestion: (claimId: string, body: AnyRecord) =>
    request<AnyRecord>(`/matching/claims/${claimId}/reject`, { method: "POST", body: JSON.stringify(body) }),
  invalidateMatchingDecision: (claimId: string, body: AnyRecord) =>
    request<AnyRecord>(`/matching/claims/${claimId}/invalidate`, { method: "POST", body: JSON.stringify(body) }),
  importFile: (type: string, file: File, sessionId?: string) => {
    const form = new FormData();
    form.set("file", file);
    if (sessionId) form.set("sessionId", sessionId);
    return request<AnyRecord>(`/imports/${type}`, { method: "POST", body: form });
  },
  confirmImport: (id: string) => request<AnyRecord>(`/imports/${id}/confirm`, { method: "POST", body: JSON.stringify({}) }),
  exportUrl: (type: string, sessionId?: string) => `${API_URL}/exports/${type}${queryString({ sessionId })}`,
  download: async (url: string) => {
    const response = await fetch(url, { headers: authHeaders() });
    if (!response.ok) throw new Error(response.statusText);
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition");
    const fileName = disposition?.match(/filename="([^"]+)"/)?.[1] ?? "zpp-connect-export";
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(objectUrl);
  },
  adminUsers: (query?: AnyRecord) => request<ApiList<AnyRecord>>(`/admin/users${queryString(query)}`),
  adminUser: (id: string) => request<AnyRecord>(`/admin/users/${id}`),
  createAdminUser: (body: AnyRecord) => request<AnyRecord>("/admin/users", { method: "POST", body: JSON.stringify(body) }),
  updateAdminUser: (id: string, body: AnyRecord) => request<AnyRecord>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  adminUserLifecycleImpact: (id: string) => request<AnyRecord>(`/admin/users/${id}/lifecycle-impact`),
  updateAdminUserAuthenticationPolicy: (id: string, body: AnyRecord) =>
    request<AnyRecord>(`/admin/users/${id}/authentication-policy`, { method: "POST", body: JSON.stringify(body) }),
  activateAdminUser: (id: string, body?: AnyRecord) => request<AnyRecord>(`/admin/users/${id}/activate`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  suspendAdminUser: (id: string, body: AnyRecord) => request<AnyRecord>(`/admin/users/${id}/suspend`, { method: "POST", body: JSON.stringify(body) }),
  archiveAdminUser: (id: string, body: AnyRecord) => request<AnyRecord>(`/admin/users/${id}/archive`, { method: "POST", body: JSON.stringify(body) }),
  restoreAdminUser: (id: string, body?: AnyRecord) => request<AnyRecord>(`/admin/users/${id}/restore`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  addAdminUserRoleAssignment: (id: string, body: AnyRecord) =>
    request<AnyRecord>(`/admin/users/${id}/role-assignments`, { method: "POST", body: JSON.stringify(body) }),
  revokeAdminUserRoleAssignment: (id: string, assignmentId: string, body?: AnyRecord) =>
    request<AnyRecord>(`/admin/users/${id}/role-assignments/${assignmentId}/revoke`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  addAdminUserCapabilityOverride: (id: string, body: AnyRecord) =>
    request<AnyRecord>(`/admin/users/${id}/capability-overrides`, { method: "POST", body: JSON.stringify(body) }),
  revokeAdminUserCapabilityOverride: (id: string, overrideId: string, body?: AnyRecord) =>
    request<AnyRecord>(`/admin/users/${id}/capability-overrides/${overrideId}/revoke`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  adminUserEffectiveAccess: (id: string) => request<AnyRecord>(`/admin/users/${id}/effective-access`),
  adminUserAccessHistory: (id: string) => request<ApiList<AnyRecord>>(`/admin/users/${id}/access-history`),
  linkAdminUserMemberProfile: (id: string, body: AnyRecord) => request<AnyRecord>(`/admin/users/${id}/member-link`, { method: "POST", body: JSON.stringify(body) }),
  unlinkAdminUserMemberProfile: (id: string) => request<AnyRecord>(`/admin/users/${id}/member-link`, { method: "DELETE" }),
  adminInvitations: (query?: AnyRecord) => request<ApiList<AnyRecord>>(`/admin/invitations${queryString(query)}`),
  adminInvitation: (id: string) => request<AnyRecord>(`/admin/invitations/${id}`),
  createAdminInvitation: (body: AnyRecord) => request<AnyRecord>("/admin/invitations", { method: "POST", body: JSON.stringify(body) }),
  regenerateAdminInvitation: (id: string, body?: AnyRecord) =>
    request<AnyRecord>(`/admin/invitations/${id}/regenerate`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  revokeAdminInvitation: (id: string, body: AnyRecord) =>
    request<AnyRecord>(`/admin/invitations/${id}/revoke`, { method: "POST", body: JSON.stringify(body) }),
  acceptLocalAdminInvitation: (id: string, body?: AnyRecord) =>
    request<AnyRecord>(`/admin/invitations/${id}/local-accept`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  adminOrganizations: () => request<ApiList<AppOrganization>>("/admin/organizations"),
  createAdminOrganization: (body: AnyRecord) => request<AppOrganization>("/admin/organizations", { method: "POST", body: JSON.stringify(body) }),
  updateAdminOrganization: (id: string, body: AnyRecord) =>
    request<AppOrganization>(`/admin/organizations/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  updateAdminUserRoles: (id: string, roles: string[]) =>
    request<AnyRecord>(`/admin/users/${id}/roles`, { method: "PATCH", body: JSON.stringify({ roles }) }),
  adminRoles: () => request<ApiList<AnyRecord>>("/admin/roles"),
  adminRole: (id: string) => request<AnyRecord>(`/admin/roles/${id}`),
  createAdminRole: (body: AnyRecord) => request<AnyRecord>("/admin/roles", { method: "POST", body: JSON.stringify(body) }),
  updateAdminRole: (id: string, body: AnyRecord) => request<AnyRecord>(`/admin/roles/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveAdminRole: (id: string, body?: AnyRecord) => request<AnyRecord>(`/admin/roles/${id}/archive`, { method: "POST", body: JSON.stringify(body ?? {}) }),
  adminCapabilities: () => request<ApiList<AnyRecord>>("/admin/capabilities"),
  adminDictionaries: () => request<ApiList<AnyRecord>>("/admin/dictionaries")
};
