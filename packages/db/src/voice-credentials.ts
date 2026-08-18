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
