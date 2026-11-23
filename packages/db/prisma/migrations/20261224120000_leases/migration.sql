-- Additive: the previous release never reads this table. A key names work, not tenant data,
-- so no row-level policy applies.
CREATE TABLE "leases" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "fence" INTEGER NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL
);
