import type { ReactNode } from "react";

export type UserRole =
  | "System Admin"
  | "ZPP Coordinator"
  | "ZPP Group Leader"
  | "ZPP Member"
  | "TEC Coordinator"
  | "TEC Group Leader"
  | "TEC Member"
  | "Observer";

export type PortalRouteKey =
  | "dashboard"
  | "active-event"
  | "sessions"
  | "tec-intake"
  | "family-nok"
  | "passenger-src"
  | "matching"
  | "release-control"
  | "requests"
  | "timeline"
  | "members"
  | "groups"
  | "rostering"
  | "assignments"
  | "training"
  | "documents"
  | "readiness"
  | "files-import"
  | "reports"
  | "users-access"
  | "roles-permissions"
  | "exercise"
  | "audit"
  | "settings";

export type DemoUser = {
  email: string;
  apiEmail: string;
  displayName: string;
  role: string;
  roles: string[];
  accessLevel: string;
  authMethod: string;
};

export type StatItem = {
  label: string;
  value: string;
  detail: string;
  tone?: "navy" | "petrol" | "gold" | "success" | "warning" | "danger";
};

export type TimelineItem = {
  time: string;
  title: string;
  detail: string;
  tone?: "neutral" | "info" | "warning" | "success" | "danger";
};

export type TableColumn<T> = {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  className?: string;
};
