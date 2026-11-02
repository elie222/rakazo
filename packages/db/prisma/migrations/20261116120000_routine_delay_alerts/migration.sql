ALTER TABLE "routines"
  ADD COLUMN "delayAlertsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "delayAlertSchedule" TIMESTAMP(3),
  ADD COLUMN "delayAlertClaimedAt" TIMESTAMP(3),
  ADD COLUMN "delayAlertSentAt" TIMESTAMP(3),
  ADD COLUMN "delayAlertResult" TEXT;
