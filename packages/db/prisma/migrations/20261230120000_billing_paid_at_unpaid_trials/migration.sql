-- A trial whose first charge failed was recorded as paid the moment it turned active.
UPDATE "billing_accounts" SET "paidAt" = NULL
WHERE "status" IN ('past_due', 'unpaid')
  AND "trialEndsAt" IS NOT NULL
  AND "currentPeriodStartsAt" = "trialEndsAt";
