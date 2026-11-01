ALTER TABLE "bots" ALTER COLUMN "crossSpaceCommunication" SET DEFAULT true;
UPDATE "bots" SET "crossSpaceCommunication" = true, "fleetManagement" = true
WHERE "crossSpaceCommunication" = false OR "fleetManagement" = false;
