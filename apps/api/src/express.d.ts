import type { AuthenticatedUser } from "./types.js";
import type { IncidentContext } from "./modules/incident-access/incident-access-types.js";
import type { Permission } from "@zpp/shared";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      requestId?: string;
      incidentContext?: IncidentContext;
      incidentPermissions?: Permission[];
    }
  }
}
