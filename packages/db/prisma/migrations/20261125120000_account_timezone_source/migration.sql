-- Additive: the previous release never reads this column and keeps its own rule
-- (a device zone only lands while the account has none).
ALTER TABLE "user" ADD COLUMN "timezoneSource" TEXT;

-- Accounts that already have a zone keep it as a hand-picked one: a saved zone cannot
-- be told from a chosen one, and a chosen zone must survive the next device report.
-- "Use {zone}" in Settings returns an account to its device.
UPDATE "user" SET "timezoneSource" = 'manual' WHERE "timezone" IS NOT NULL;
