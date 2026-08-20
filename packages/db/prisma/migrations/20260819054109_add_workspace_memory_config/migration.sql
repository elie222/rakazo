-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "memoryScope" TEXT;

-- AlterTable
ALTER TABLE "computers" ALTER COLUMN "scope" SET DEFAULT 'team';

-- CreateTable
CREATE TABLE "workspace_memory_configs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "defaultMemoryScope" TEXT NOT NULL DEFAULT 'isolated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_memory_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_memory_configs_workspaceId_key" ON "workspace_memory_configs"("workspaceId");

-- AddForeignKey
ALTER TABLE "workspace_memory_configs" ADD CONSTRAINT "workspace_memory_configs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
