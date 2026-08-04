ALTER TABLE "AssignmentTask"
  ADD COLUMN IF NOT EXISTS "assignedUserId" UUID,
  ADD COLUMN IF NOT EXISTS "assignedUserDisplayName" TEXT;

UPDATE "AssignmentTask"
SET "assignedUserDisplayName" = "ownerAssignedTo"
WHERE "assignedUserDisplayName" IS NULL
  AND "ownerAssignedTo" IS NOT NULL;

UPDATE "AssignmentTask" AS task
SET "assignedUserId" = matched_user.id
FROM (
  VALUES
    ('Volunteer 01', 'volunteer@lot.pl'),
    ('Crisis Coordinator', 'coordinator@lot.pl'),
    ('System Admin', 'admin@lot.pl'),
    ('ZPP Leader', 'zpp@lot.pl'),
    ('TEC Operator', 'tec@lot.pl')
) AS legacy(display_name, email)
JOIN "User" AS matched_user ON matched_user.email = legacy.email
WHERE task."assignedUserId" IS NULL
  AND task."ownerAssignedTo" = legacy.display_name;

DO $$
BEGIN
  ALTER TABLE "AssignmentTask"
    ADD CONSTRAINT "AssignmentTask_assignedUserId_fkey"
    FOREIGN KEY ("assignedUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "AssignmentTask_assignedUserId_idx" ON "AssignmentTask"("assignedUserId");
