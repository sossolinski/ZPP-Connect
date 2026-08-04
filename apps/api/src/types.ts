import type { Permission } from "@zpp/shared";

export type AuthenticatedUser = {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  department?: string | null;
  organizationId?: string | null;
  organization?: {
    id: string;
    key: string;
    name: string;
    type?: string | null;
    status?: string | null;
    contactEmail?: string | null;
  } | null;
  roles: string[];
  roleLabels?: string[];
  roleAssignments?: Array<{
    id: string;
    userId: string;
    roleName: string;
    scopeType: "GLOBAL" | "GROUP";
    scopeId?: string | null;
    status: "Active" | "Revoked";
    assignedAt: string;
    assignedByUserId?: string | null;
  }>;
  deniedPermissions?: Permission[];
  permissions: Permission[];
};

export type RequestActor = AuthenticatedUser;
