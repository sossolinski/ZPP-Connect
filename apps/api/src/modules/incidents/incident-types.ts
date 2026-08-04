export type IncidentActor = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  requestId?: string;
};

export type IncidentRecord = {
  id: string;
  operationalId: string;
  mode: string;
  status: string;
  eventType: string;
  flightNumber?: string | null;
  route?: string | null;
  aircraftRegistration?: string | null;
  airportLocation?: string | null;
  description?: string | null;
  startAt?: Date | string | null;
  endAt?: Date | string | null;
  notes?: string | null;
  createdById?: string | null;
  closedById?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  [key: string]: unknown;
};

export type IncidentCreateInput = {
  mode: string;
  status: string;
  eventType: string;
  flightNumber?: string | null;
  route?: string | null;
  aircraftRegistration?: string | null;
  airportLocation?: string | null;
  description?: string | null;
  startAt?: Date | null;
  endAt?: Date | null;
  notes?: string | null;
};

export type IncidentUpdateInput = Partial<IncidentCreateInput>;

export type IncidentListQuery = {
  status?: string;
  search?: string;
  limit: number;
  offset: number;
};

export type IncidentListResult = {
  total: number;
  data: IncidentRecord[];
};
