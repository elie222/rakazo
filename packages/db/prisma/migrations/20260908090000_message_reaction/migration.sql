ALTER TABLE "messages" ADD COLUMN "reaction" TEXT;
UPDATE "messages" SET "reaction" = '👍' WHERE "thumbsUp" = true;
