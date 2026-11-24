ALTER TABLE "computers" ADD COLUMN "size" TEXT NOT NULL DEFAULT 'standard';

-- Each computer keeps the size its organization had chosen for all of them.
UPDATE "computers" AS c
SET "size" = o."computerSize"
FROM "spaces" AS s
JOIN "organization" AS o ON o."id" = s."organizationId"
WHERE c."spaceId" = s."id" AND o."computerSize" <> 'standard';
