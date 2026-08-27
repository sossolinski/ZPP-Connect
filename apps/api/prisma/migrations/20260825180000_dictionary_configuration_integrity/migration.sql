ALTER TABLE "Dictionary"
  ADD COLUMN "normalizedKey" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'LEGACY_BOOTSTRAP';

UPDATE "Dictionary"
SET
  "normalizedKey" = trim(BOTH '_' FROM lower(regexp_replace(trim("key"), '[^a-zA-Z0-9]+', '_', 'g'))),
  "sourceType" = CASE
    WHEN "category" = 'profile' THEN 'LEGACY_PROFILE_MIRROR'
    WHEN "category" IN ('eventTypes', 'requestCategories') THEN 'BOOTSTRAP'
    ELSE 'SYSTEM_MIRROR'
  END;

ALTER TABLE "Dictionary"
  ALTER COLUMN "normalizedKey" SET NOT NULL,
  ADD CONSTRAINT "Dictionary_normalized_key_check" CHECK ("normalizedKey" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  ADD CONSTRAINT "Dictionary_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "Dictionary_source_type_check" CHECK ("sourceType" IN ('SYSTEM_MIRROR', 'BOOTSTRAP', 'ADMIN', 'LEGACY_PROFILE_MIRROR'));

CREATE UNIQUE INDEX "Dictionary_profile_category_normalizedKey_key"
  ON "Dictionary"("profile", "category", "normalizedKey");
