import type { PrismaClient } from "@rakazo/db";

export type CompanyEventInput = {
  workspaceId: string;
  type: string;
  actorBotId?: string | null;
  workItemId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  escalationId?: string | null;
  payload?: Record<string, unknown>;
};

export async function emitCompanyEvent(prisma: PrismaClient, input: CompanyEventInput) {
  return prisma.companyEvent.create({
    data: {
      workspaceId: input.workspaceId,
      type: input.type,
      actorBotId: input.actorBotId ?? null,
      workItemId: input.workItemId ?? null,
      projectId: input.projectId ?? null,
      goalId: input.goalId ?? null,
      escalationId: input.escalationId ?? null,
      payload: (input.payload ?? {}) as never,
    },
  });
}

export async function listCompanyEvents(
  prisma: PrismaClient,
  workspaceId: string,
  limit = 50,
) {
  return prisma.companyEvent.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
