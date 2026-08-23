import type { PrismaClient } from "./client.js";
import { newestModelCredentialOrder } from "./model-credentials.js";

export const newestVoiceCredentialOrder = newestModelCredentialOrder;

export function findDefaultVoiceCredential(
  prisma: PrismaClient,
  scope: { userId: string; workspaceId: string },
) {
  return prisma.userVoiceCredential.findFirst({
    where: { userId: scope.userId, workspaceId: scope.workspaceId, isDefault: true },
    orderBy: newestVoiceCredentialOrder,
  });
}

export function findVoiceCredential(
  prisma: PrismaClient,
  scope: { userId: string; workspaceId: string },
  provider: string,
) {
  return prisma.userVoiceCredential.findUnique({
    where: {
      userId_workspaceId_provider: {
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        provider,
      },
    },
  });
}
