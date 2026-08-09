CREATE SEQUENCE "Session_operational_seq" START WITH 1;
CREATE SEQUENCE "Enquiry_operational_seq" START WITH 1;

DO $$
DECLARE
  session_max BIGINT;
  enquiry_max BIGINT;
BEGIN
  SELECT COALESCE(MAX((regexp_match("operationalId", '([0-9]+)$'))[1]::BIGINT), 0)
  INTO session_max
  FROM "Session"
  WHERE "operationalId" ~ '^SES-[0-9]{4}-[0-9]+$';

  IF session_max > 0 THEN
    PERFORM setval('"Session_operational_seq"', session_max, true);
  END IF;

  SELECT COALESCE(MAX((regexp_match("operationalId", '([0-9]+)$'))[1]::BIGINT), 0)
  INTO enquiry_max
  FROM "Enquiry"
  WHERE "operationalId" ~ '^TEC-[0-9]{4}-[0-9]+$';

  IF enquiry_max > 0 THEN
    PERFORM setval('"Enquiry_operational_seq"', enquiry_max, true);
  END IF;
END $$;
