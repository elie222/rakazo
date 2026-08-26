-- CreateTable
CREATE TABLE "bot_shares" (
    "token" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "bot_shares_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE INDEX "bot_shares_workspaceId_createdByUserId_idx" ON "bot_shares"("workspaceId", "createdByUserId");

-- AddForeignKey
ALTER TABLE "bot_shares" ADD CONSTRAINT "bot_shares_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_shares" ADD CONSTRAINT "bot_shares_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
