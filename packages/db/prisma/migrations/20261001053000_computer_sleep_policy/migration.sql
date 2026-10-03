ALTER TABLE "computers" ADD COLUMN "sleepPolicy" TEXT NOT NULL DEFAULT 'automatic';
ALTER TABLE "computers" ADD COLUMN "keepAwakeUntil" TIMESTAMP(3);
