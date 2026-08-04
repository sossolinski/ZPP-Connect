import type { PrismaClient } from "@prisma/client";
import type { IncidentAccessRepository } from "./incident-access-repository.js";

export function createPrismaIncidentAccessRepository(client: PrismaClient): IncidentAccessRepository {
  return {
    async resolve(incidentId, actorEmail) {
      const incident = await client.session.findUnique({
        where: { id: incidentId },
        select: {
          id: true,
          mode: true,
          status: true,
          incidentAssignments: {
            where: { active: true, user: { email: actorEmail.toLowerCase(), status: "active" } },
            select: { userId: true },
            take: 1
          }
        }
      });
      if (!incident) return null;
      const user = await client.user.findUnique({
        where: { email: actorEmail.toLowerCase() },
        select: { id: true }
      });
      return {
        incidentId: incident.id,
        mode: incident.mode,
        status: incident.status,
        assigned: incident.incidentAssignments.length > 0,
        databaseUserId: user?.id
      };
    },

    async listAssignedIncidentIds(actorEmail) {
      const rows = await client.incidentAssignment.findMany({
        where: { active: true, user: { email: actorEmail.toLowerCase(), status: "active" } },
        select: { incidentId: true }
      });
      return rows.map((row) => row.incidentId);
    }
  };
}
