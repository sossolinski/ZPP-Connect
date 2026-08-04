ALTER TABLE "Enquiry"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Enquiry"
  ADD CONSTRAINT "Enquiry_version_positive_check" CHECK ("version" > 0);

DROP INDEX "Enquiry_sessionId_status_idx";
CREATE INDEX "Enquiry_sessionId_status_updatedAt_idx"
  ON "Enquiry"("sessionId", "status", "updatedAt");

CREATE TABLE "IncidentAssignment" (
  "id" UUID NOT NULL,
  "incidentId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "function" TEXT,
  "scope" TEXT NOT NULL DEFAULT 'OPERATIONAL',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" UUID,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "IncidentAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IncidentAssignment_incidentId_userId_key"
  ON "IncidentAssignment"("incidentId", "userId");
CREATE INDEX "IncidentAssignment_userId_active_idx"
  ON "IncidentAssignment"("userId", "active");
CREATE INDEX "IncidentAssignment_incidentId_active_idx"
  ON "IncidentAssignment"("incidentId", "active");

ALTER TABLE "IncidentAssignment"
  ADD CONSTRAINT "IncidentAssignment_incidentId_fkey"
  FOREIGN KEY ("incidentId") REFERENCES "Session"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentAssignment"
  ADD CONSTRAINT "IncidentAssignment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentAssignment"
  ADD CONSTRAINT "IncidentAssignment_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "IncidentAssignment" (
  "id", "incidentId", "userId", "function", "scope", "active", "createdAt", "createdById"
)
SELECT
  md5(session."id"::text || ':' || session."createdById"::text)::uuid,
  session."id",
  session."createdById",
  'Incident creator',
  'OPERATIONAL',
  true,
  CURRENT_TIMESTAMP,
  session."createdById"
FROM "Session" session
WHERE session."createdById" IS NOT NULL
ON CONFLICT ("incidentId", "userId") DO NOTHING;

CREATE FUNCTION "enforce_enquiry_passenger_incident"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."passengerRecordId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "PassengerRecord" passenger
    WHERE passenger."id" = NEW."passengerRecordId"
      AND passenger."sessionId" = NEW."sessionId"
  ) THEN
    RAISE EXCEPTION 'Enquiry passenger record must belong to the same incident'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Enquiry_passenger_incident_check"
BEFORE INSERT OR UPDATE OF "passengerRecordId", "sessionId" ON "Enquiry"
FOR EACH ROW EXECUTE FUNCTION "enforce_enquiry_passenger_incident"();
