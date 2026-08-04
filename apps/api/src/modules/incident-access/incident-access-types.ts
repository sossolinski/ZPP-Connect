export type IncidentAccessActor = {
  id: string;
  email: string;
  roles: string[];
};

export type IncidentAccessRecord = {
  incidentId: string;
  mode: string;
  status: string;
  assigned: boolean;
  databaseUserId?: string;
};

export type IncidentContext = {
  incidentId: string;
  mode: string;
  status: string;
  actorId: string;
  actorEmail: string;
  systemAdminOverride: boolean;
  writable: boolean;
};
