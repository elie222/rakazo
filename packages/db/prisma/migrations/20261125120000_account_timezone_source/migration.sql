-- Additive: the previous release never reads this column and keeps its own rule
-- (a device zone only lands while the account has none).
ALTER TABLE "user" ADD COLUMN "timezoneSource" TEXT;

-- Accounts that already have a zone start following the device: every current user gets
-- the new behavior at once. A zone that was picked by hand may move when its owner
-- travels; picking one again keeps it from then on.
UPDATE "user" SET "timezoneSource" = 'device' WHERE "timezone" IS NOT NULL;
