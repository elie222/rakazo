-- Additive: older releases never read or write these tables.
-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "start" TEXT,
    "referenceId" TEXT NOT NULL,
    "prefix" TEXT,
    "key" TEXT NOT NULL,
    "refillInterval" INTEGER,
    "refillAmount" INTEGER,
    "lastRefillAt" TIMESTAMP(3),
    "enabled" BOOLEAN DEFAULT true,
    "rateLimitEnabled" BOOLEAN DEFAULT true,
    "rateLimitTimeWindow" INTEGER,
    "rateLimitMax" INTEGER,
    "requestCount" INTEGER DEFAULT 0,
    "remaining" INTEGER,
    "lastRequest" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "permissions" TEXT,
    "metadata" TEXT,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_callbacks" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_keys_configId_idx" ON "api_keys"("configId");

-- CreateIndex
CREATE INDEX "api_keys_referenceId_idx" ON "api_keys"("referenceId");

-- CreateIndex
CREATE INDEX "api_keys_key_idx" ON "api_keys"("key");

-- CreateIndex
CREATE UNIQUE INDEX "task_callbacks_taskId_key" ON "task_callbacks"("taskId");

-- CreateIndex
CREATE INDEX "task_callbacks_spaceId_userId_idx" ON "task_callbacks"("spaceId", "userId");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_callbacks" ADD CONSTRAINT "task_callbacks_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A callback belongs to the member who started the task.
ALTER TABLE "task_callbacks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "task_callbacks_tenant" ON "task_callbacks"
    USING ("spaceId" = current_setting('app.space_id', true) AND "userId" = current_setting('app.user_id', true));
CREATE POLICY "task_callbacks_system" ON "task_callbacks" USING ((SELECT app_rls_bypass()));
