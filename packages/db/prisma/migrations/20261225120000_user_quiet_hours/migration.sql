ALTER TABLE "user" ADD COLUMN "quietHoursStart" INTEGER;
ALTER TABLE "user" ADD COLUMN "quietHoursEnd" INTEGER;
-- Both set to two different hours with a timezone to read them in, or both off. Spelled out,
-- since a check passes when a comparison with a null is unknown. NOT VALID skips scanning
-- existing rows under the table lock: their new columns are all null, and every write from here
-- on is still checked.
ALTER TABLE "user" ADD CONSTRAINT "user_quiet_hours_valid"
 CHECK (
  ("quietHoursStart" IS NULL AND "quietHoursEnd" IS NULL)
  OR (
   "quietHoursStart" IS NOT NULL
   AND "quietHoursEnd" IS NOT NULL
   AND "timezone" IS NOT NULL
   AND "quietHoursStart" BETWEEN 0 AND 23
   AND "quietHoursEnd" BETWEEN 0 AND 23
   AND "quietHoursStart" <> "quietHoursEnd"
  )
 ) NOT VALID;
