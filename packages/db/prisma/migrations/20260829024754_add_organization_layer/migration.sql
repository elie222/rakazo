-- AlterTable
ALTER TABLE "computers" ALTER COLUMN "scope" SET DEFAULT 'team';

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "parentDepartmentId" TEXT,
    "managerBotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "departmentId" TEXT,
    "reportsToBotId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'employee',
    "mission" TEXT NOT NULL DEFAULT '',
    "responsibilities" JSONB NOT NULL DEFAULT '[]',
    "authority" JSONB NOT NULL DEFAULT '{}',
    "autonomyLevel" TEXT NOT NULL DEFAULT 'standard',
    "workMode" TEXT NOT NULL DEFAULT 'standard',
    "status" TEXT NOT NULL DEFAULT 'idle',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_runtime_states" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "currentWorkItemId" TEXT,
    "lastActiveAt" TIMESTAMP(3),
    "lastEvaluationAt" TIMESTAMP(3),
    "nextWakeAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseFence" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "state" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_runtime_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_goals" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "ownerBotId" TEXT,
    "startsAt" TIMESTAMP(3),
    "targetAt" TIMESTAMP(3),
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "goalId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "ownerBotId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_items" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "parentWorkItemId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'backlog',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "createdByBotId" TEXT,
    "assignedToBotId" TEXT,
    "reviewerBotId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "expectedOutcome" TEXT NOT NULL DEFAULT '',
    "dueAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_reviews" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "reviewerBotId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "summary" TEXT NOT NULL DEFAULT '',
    "feedback" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_item_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceBotId" TEXT NOT NULL,
    "targetBotId" TEXT,
    "workItemId" TEXT,
    "reason" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "context" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sops" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "trigger" TEXT NOT NULL,
    "definition" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorBotId" TEXT,
    "workItemId" TEXT,
    "projectId" TEXT,
    "goalId" TEXT,
    "escalationId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "departments_workspaceId_idx" ON "departments"("workspaceId");

-- CreateIndex
CREATE INDEX "departments_workspaceId_parentDepartmentId_idx" ON "departments"("workspaceId", "parentDepartmentId");

-- CreateIndex
CREATE INDEX "departments_managerBotId_idx" ON "departments"("managerBotId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_botId_key" ON "employee_profiles"("botId");

-- CreateIndex
CREATE INDEX "employee_profiles_workspaceId_idx" ON "employee_profiles"("workspaceId");

-- CreateIndex
CREATE INDEX "employee_profiles_workspaceId_departmentId_idx" ON "employee_profiles"("workspaceId", "departmentId");

-- CreateIndex
CREATE INDEX "employee_profiles_reportsToBotId_idx" ON "employee_profiles"("reportsToBotId");

-- CreateIndex
CREATE UNIQUE INDEX "employee_runtime_states_botId_key" ON "employee_runtime_states"("botId");

-- CreateIndex
CREATE INDEX "employee_runtime_states_workspaceId_status_idx" ON "employee_runtime_states"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "employee_runtime_states_nextWakeAt_idx" ON "employee_runtime_states"("nextWakeAt");

-- CreateIndex
CREATE INDEX "company_goals_workspaceId_status_idx" ON "company_goals"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "company_goals_ownerBotId_idx" ON "company_goals"("ownerBotId");

-- CreateIndex
CREATE INDEX "projects_workspaceId_status_idx" ON "projects"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "projects_workspaceId_goalId_idx" ON "projects"("workspaceId", "goalId");

-- CreateIndex
CREATE INDEX "projects_ownerBotId_idx" ON "projects"("ownerBotId");

-- CreateIndex
CREATE UNIQUE INDEX "work_items_idempotencyKey_key" ON "work_items"("idempotencyKey");

-- CreateIndex
CREATE INDEX "work_items_workspaceId_status_idx" ON "work_items"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "work_items_workspaceId_projectId_idx" ON "work_items"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "work_items_workspaceId_assignedToBotId_idx" ON "work_items"("workspaceId", "assignedToBotId");

-- CreateIndex
CREATE INDEX "work_items_parentWorkItemId_idx" ON "work_items"("parentWorkItemId");

-- CreateIndex
CREATE INDEX "work_items_reviewerBotId_idx" ON "work_items"("reviewerBotId");

-- CreateIndex
CREATE INDEX "work_item_reviews_workspaceId_workItemId_idx" ON "work_item_reviews"("workspaceId", "workItemId");

-- CreateIndex
CREATE INDEX "work_item_reviews_reviewerBotId_idx" ON "work_item_reviews"("reviewerBotId");

-- CreateIndex
CREATE INDEX "escalations_workspaceId_status_idx" ON "escalations"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "escalations_sourceBotId_idx" ON "escalations"("sourceBotId");

-- CreateIndex
CREATE INDEX "escalations_targetBotId_idx" ON "escalations"("targetBotId");

-- CreateIndex
CREATE INDEX "sops_workspaceId_trigger_idx" ON "sops"("workspaceId", "trigger");

-- CreateIndex
CREATE UNIQUE INDEX "sops_workspaceId_name_key" ON "sops"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "company_events_workspaceId_type_idx" ON "company_events"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "company_events_workspaceId_createdAt_idx" ON "company_events"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "company_events_actorBotId_idx" ON "company_events"("actorBotId");

-- CreateIndex
CREATE INDEX "company_events_workItemId_idx" ON "company_events"("workItemId");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_parentDepartmentId_fkey" FOREIGN KEY ("parentDepartmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_runtime_states" ADD CONSTRAINT "employee_runtime_states_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_runtime_states" ADD CONSTRAINT "employee_runtime_states_botId_fkey" FOREIGN KEY ("botId") REFERENCES "employee_profiles"("botId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_goals" ADD CONSTRAINT "company_goals_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "company_goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_parentWorkItemId_fkey" FOREIGN KEY ("parentWorkItemId") REFERENCES "work_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_reviews" ADD CONSTRAINT "work_item_reviews_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_reviews" ADD CONSTRAINT "work_item_reviews_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sops" ADD CONSTRAINT "sops_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_events" ADD CONSTRAINT "company_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "action_approval_rules_workspaceId_createdByUserId_effect_matchK" RENAME TO "action_approval_rules_workspaceId_createdByUserId_effect_ma_key";
