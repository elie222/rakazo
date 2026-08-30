import type { PrismaClient } from "@rakazo/db";

export type HumanAttentionItem = {
  id: string;
  type: "approval" | "escalation" | "failure";
  priority: "medium" | "high" | "critical";
  title: string;
  summary: string;
  sourceEntityType: "work_item" | "escalation";
  sourceEntityId: string;
  createdAt: Date;
};

/** A read model over existing durable state, not a second workflow engine. */
export function createHumanAttentionService(prisma: PrismaClient) {
  return {
    async getHumanAttentionItems(workspaceId: string): Promise<HumanAttentionItem[]> {
      const [escalations, approvals, failures] = await Promise.all([
        prisma.escalation.findMany({ where: { workspaceId, status: "open", targetBotId: null }, orderBy: { createdAt: "desc" }, take: 100 }),
        prisma.workItem.findMany({ where: { workspaceId, status: "waiting_approval" }, orderBy: { updatedAt: "asc" }, take: 100 }),
        prisma.workItem.findMany({ where: { workspaceId, status: "failed", escalations: { none: { status: "open", targetBotId: { not: null } } } }, orderBy: { updatedAt: "desc" }, take: 100 }),
      ]);
      return [
        ...escalations.map((item) => ({ id: `escalation:${item.id}`, type: "escalation" as const, priority: item.severity === "critical" ? ("critical" as const) : ("high" as const), title: "Escalation needs human attention", summary: item.reason, sourceEntityType: "escalation" as const, sourceEntityId: item.id, createdAt: item.createdAt })),
        ...approvals.map((item) => ({ id: `approval:${item.id}`, type: "approval" as const, priority: "high" as const, title: `Approval needed: ${item.title}`, summary: item.expectedOutcome || item.description, sourceEntityType: "work_item" as const, sourceEntityId: item.id, createdAt: item.updatedAt })),
        ...failures.map((item) => ({ id: `failure:${item.id}`, type: "failure" as const, priority: "high" as const, title: `Failed work: ${item.title}`, summary: item.expectedOutcome || item.description, sourceEntityType: "work_item" as const, sourceEntityId: item.id, createdAt: item.updatedAt })),
      ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
  };
}
