-- New computers default to the workspace Team Computer. Existing rows keep their stored
-- scope; only the column default changes to match the Prisma schema.
ALTER TABLE "computers" ALTER COLUMN "scope" SET DEFAULT 'team';
