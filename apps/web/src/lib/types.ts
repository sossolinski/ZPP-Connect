export type ApiList<T = Record<string, unknown>> = {
  total?: number;
  data: T[];
};

export type SessionRecord = {
  id: string;
  operationalId: string;
  mode: "REAL" | "EXERCISE" | "TRAINING";
  status: string;
  eventType: string;
  flightNumber?: string | null;
  route?: string | null;
  aircraftRegistration?: string | null;
  airportLocation?: string | null;
  description?: string | null;
  startAt?: string | null;
  endAt?: string | null;
  notes?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type UserContext = {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  department?: string | null;
  organizationId?: string | null;
  organization?: AppOrganization | null;
  roles: string[];
  roleLabels?: string[];
  roleAssignments?: Array<{
    id: string;
    userId: string;
    roleName: string;
    scopeType: "GLOBAL" | "GROUP";
    scopeId?: string | null;
    status: string;
    assignedAt: string;
    assignedByUserId?: string | null;
  }>;
  deniedPermissions?: string[];
  permissions: string[];
};

export type AppOrganization = {
  id: string;
  key: string;
  name: string;
  type?: string | null;
  status?: string | null;
  contactEmail?: string | null;
  description?: string | null;
};

export type DictionaryItem = {
  id: string;
  category: string;
  key: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
  version?: number;
  description?: string | null;
  sourceType?: string;
  policy?: DictionaryPolicy;
};

export type DictionaryPolicy = {
  category: string;
  classification: "P" | "E" | "L" | "D" | "X";
  authority: "code" | "postgres";
  protected: boolean;
  allowCreate: boolean;
  allowLabelEdit: boolean;
  allowDescriptionEdit: boolean;
  allowReorder: boolean;
  allowDeactivate: boolean;
  allowReactivate: boolean;
  reason: string;
};

export type DictionaryMap = Record<string, DictionaryItem[]>;

export type AppProfile = {
  organizationName: string;
  appSubtitle: string;
  genericSubtitle: string;
  teamName: string;
  contactEmail: string;
  author: string;
  footerText: string;
  exerciseLabels: Record<string, string>;
};

export type AnyRecord = Record<string, any>;
