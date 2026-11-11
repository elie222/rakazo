ALTER TABLE "user" ADD COLUMN "quietHoursStart" INTEGER;
ALTER TABLE "user" ADD COLUMN "quietHoursEnd" INTEGER;
ALTER TABLE "user" ADD CONSTRAINT "user_quiet_hours_valid"
 CHECK (
  ("quietHoursStart" IS NULL AND "quietHoursEnd" IS NULL)
  OR (
   "quietHoursStart" BETWEEN 0 AND 23
   AND "quietHoursEnd" BETWEEN 0 AND 23
   AND "quietHoursStart" <> "quietHoursEnd"
  )
 );
