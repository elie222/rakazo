import type { PrismaClient } from "./client.js";

export const newestModelCredentialOrder = [
  { updatedAt: "desc" as const },
  { createdAt: "desc" as const },
  { id: "desc" as const },
];

export function findDefaultModelCredential(
  prisma: PrismaClient,
  scope: { userId: string; workspaceId: string },
) {
  return prisma.userModelCredential.findFirst({
    where: { userId: scope.userId, workspaceId: scope.workspaceId, isDefault: true },
    orderBy: newestModelCredentialOrder,
  });
}

export function findModelCredential(
  prisma: PrismaClient,
  scope: { userId: string; workspaceId: string },
  provider: string,
) {
  return prisma.userModelCredential.findFirst({
    where: { userId: scope.userId, workspaceId: scope.workspaceId, provider },
    orderBy: newestModelCredentialOrder,
  });
}
