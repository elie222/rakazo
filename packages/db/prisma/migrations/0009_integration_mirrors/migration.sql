CREATE TABLE "integration_mirrors" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "lane" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "slackMessageTs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_mirrors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_mirrors_workspaceId_lane_externalId_key"
ON "integration_mirrors"("workspaceId", "lane", "externalId");

CREATE INDEX "integration_mirrors_workspaceId_lane_idx"
ON "integration_mirrors"("workspaceId", "lane");

ALTER TABLE "integration_mirrors" ADD CONSTRAINT "integration_mirrors_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
