ALTER TABLE "IncidentAssignment"
  ADD COLUMN "revokedById" UUID,
  ADD COLUMN "revokeReason" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "IncidentAssignment"
  ADD CONSTRAINT "IncidentAssignment_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "IncidentAssignment_incidentId_active_createdAt_idx"
  ON "IncidentAssignment"("incidentId", "active", "createdAt");
