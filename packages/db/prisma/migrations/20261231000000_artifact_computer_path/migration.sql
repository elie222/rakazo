ALTER TABLE "artifacts" ADD COLUMN "computerPath" TEXT;

-- Two files of one space never share a copy's path; a clash takes the next counter.
CREATE UNIQUE INDEX "artifacts_space_computer_path_key" ON "artifacts" ("spaceId", "computerPath") WHERE "computerPath" IS NOT NULL;
