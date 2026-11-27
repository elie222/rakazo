ALTER TABLE "routines" ADD COLUMN "endsAt" TIMESTAMP(3);

-- The ended-routine sweep reads only routines with an end; Prisma cannot express partial indexes.
CREATE INDEX "routines_ends_at_idx" ON "routines"("endsAt") WHERE "endsAt" IS NOT NULL;
