CREATE TABLE "Notification" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "recipientUserId" UUID NOT NULL,
  "deduplicationKey" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "sessionId" UUID,
  "sessionLabel" TEXT,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceLabel" TEXT,
  "conditionType" TEXT,
  "actionDestination" TEXT,
  "actionLabel" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "readAt" TIMESTAMPTZ,
  "resolvedAt" TIMESTAMPTZ,
  "resolutionReason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Notification_kind_check" CHECK ("kind" IN ('Action required', 'Information')),
  CONSTRAINT "Notification_mode_check" CHECK ("mode" IN ('EVENT', 'CONDITION')),
  CONSTRAINT "Notification_severity_check" CHECK ("severity" IN ('Critical', 'Attention', 'Information')),
  CONSTRAINT "Notification_action_destination_check" CHECK ("actionDestination" IS NULL OR ("actionDestination" LIKE '/%' AND "actionDestination" NOT LIKE '//%')),
  CONSTRAINT "Notification_condition_shape_check" CHECK (("mode" = 'EVENT' AND "conditionType" IS NULL AND "kind" = 'Information') OR ("mode" = 'CONDITION' AND "conditionType" IS NOT NULL)),
  CONSTRAINT "Notification_version_check" CHECK ("version" > 0),
  CONSTRAINT "Notification_recipient_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Notification_session_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Notification_recipientUserId_deduplicationKey_key" ON "Notification"("recipientUserId", "deduplicationKey");
CREATE INDEX "Notification_recipientUserId_createdAt_idx" ON "Notification"("recipientUserId", "createdAt");
CREATE INDEX "Notification_recipientUserId_readAt_createdAt_idx" ON "Notification"("recipientUserId", "readAt", "createdAt");
CREATE INDEX "Notification_recipientUserId_resolvedAt_createdAt_idx" ON "Notification"("recipientUserId", "resolvedAt", "createdAt");
CREATE INDEX "Notification_recipientUserId_category_idx" ON "Notification"("recipientUserId", "category");
CREATE INDEX "Notification_sourceType_sourceId_conditionType_idx" ON "Notification"("sourceType", "sourceId", "conditionType");
CREATE INDEX "Notification_sessionId_recipientUserId_idx" ON "Notification"("sessionId", "recipientUserId");

CREATE OR REPLACE FUNCTION "Notification_immutability_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."conditionType" IS NULL AND (
    NEW."recipientUserId" IS DISTINCT FROM OLD."recipientUserId" OR
    NEW."deduplicationKey" IS DISTINCT FROM OLD."deduplicationKey" OR
    NEW."mode" IS DISTINCT FROM OLD."mode" OR
    NEW."kind" IS DISTINCT FROM OLD."kind" OR
    NEW."severity" IS DISTINCT FROM OLD."severity" OR
    NEW."category" IS DISTINCT FROM OLD."category" OR
    NEW."title" IS DISTINCT FROM OLD."title" OR
    NEW."message" IS DISTINCT FROM OLD."message" OR
    NEW."sessionId" IS DISTINCT FROM OLD."sessionId" OR
    NEW."sessionLabel" IS DISTINCT FROM OLD."sessionLabel" OR
    NEW."sourceType" IS DISTINCT FROM OLD."sourceType" OR
    NEW."sourceId" IS DISTINCT FROM OLD."sourceId" OR
    NEW."sourceLabel" IS DISTINCT FROM OLD."sourceLabel" OR
    NEW."conditionType" IS DISTINCT FROM OLD."conditionType" OR
    NEW."actionDestination" IS DISTINCT FROM OLD."actionDestination" OR
    NEW."actionLabel" IS DISTINCT FROM OLD."actionLabel" OR
    NEW."metadata" IS DISTINCT FROM OLD."metadata" OR
    NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt" OR
    NEW."resolutionReason" IS DISTINCT FROM OLD."resolutionReason" OR
    NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
    NEW."version" IS DISTINCT FROM OLD."version"
  ) THEN RAISE EXCEPTION 'notification event content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Notification_immutability_guard" BEFORE UPDATE ON "Notification" FOR EACH ROW EXECUTE FUNCTION "Notification_immutability_guard"();

CREATE TABLE "NotificationOutbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "eventType" TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "aggregateVersion" TEXT NOT NULL,
  "recipientUserId" UUID,
  "sessionId" UUID,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 8,
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ,
  "leaseUntil" TIMESTAMPTZ,
  "lockedBy" TEXT,
  "deliveredAt" TIMESTAMPTZ,
  "failedAt" TIMESTAMPTZ,
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationOutbox_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED')),
  CONSTRAINT "NotificationOutbox_attempt_check" CHECK ("attemptCount" >= 0 AND "maxAttempts" > 0)
);
CREATE UNIQUE INDEX "NotificationOutbox_event_aggregate_version_key" ON "NotificationOutbox"("eventType", "aggregateType", "aggregateId", "aggregateVersion");
CREATE INDEX "NotificationOutbox_status_availableAt_createdAt_idx" ON "NotificationOutbox"("status", "availableAt", "createdAt");
CREATE INDEX "NotificationOutbox_leaseUntil_status_idx" ON "NotificationOutbox"("leaseUntil", "status");
CREATE INDEX "NotificationOutbox_recipientUserId_status_idx" ON "NotificationOutbox"("recipientUserId", "status");
CREATE INDEX "NotificationOutbox_aggregateType_aggregateId_status_idx" ON "NotificationOutbox"("aggregateType", "aggregateId", "status");
