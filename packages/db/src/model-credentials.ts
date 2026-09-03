import type { PrismaClient } from "./client.js";

export const newestCredentialOrder = [
  { updatedAt: "desc" as const },
  { createdAt: "desc" as const },
  { id: "desc" as const },
];

export const newestModelCredentialOrder = newestCredentialOrder;

type ModelCredentialScope = { userId: string; spaceId: string };

export async function selectSpaceModelPreference(
  prisma: Pick<PrismaClient, "spaceModelPreference">,
  scope: ModelCredentialScope,
  credentialId: string,
  modelId: string | null,
) {
  await prisma.spaceModelPreference.updateMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      isDefault: true,
      credentialId: { not: credentialId },
    },
    data: { isDefault: false },
  });
  return prisma.spaceModelPreference.upsert({
    where: {
      spaceId_userId_credentialId: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        credentialId,
      },
    },
    create: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      credentialId,
      modelId,
      isDefault: true,
    },
    update: { modelId, isDefault: true },
  });
}

function withModelPreference<
  T extends {
    credential: {
      id: string;
      userId: string;
      provider: string;
      label: string;
      secretId: string;
      createdAt: Date;
      updatedAt: Date;
    };
    isDefault: boolean;
    modelId: string | null;
  },
>(preference: T) {
  return {
    ...preference.credential,
    isDefault: preference.isDefault,
    defaultModel: preference.modelId,
  };
}

export async function findDefaultModelCredential(
  prisma: PrismaClient,
  scope: ModelCredentialScope,
) {
  const preference = await prisma.spaceModelPreference.findFirst({
    where: { spaceId: scope.spaceId, userId: scope.userId, isDefault: true },
    include: { credential: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  return preference ? withModelPreference(preference) : null;
}

export function findNewestUserModelCredential(
  prisma: PrismaClient,
  userId: string,
  provider: string,
) {
  return prisma.userModelCredential.findFirst({
    where: { userId, provider },
    orderBy: newestModelCredentialOrder,
  });
}

export async function findModelCredential(
  prisma: PrismaClient,
  scope: ModelCredentialScope,
  provider: string,
) {
  const preference = await prisma.spaceModelPreference.findFirst({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      credential: { provider },
    },
    include: { credential: true },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
  });
  if (preference) return withModelPreference(preference);
  const credential = await findNewestUserModelCredential(prisma, scope.userId, provider);
  return credential ? { ...credential, isDefault: false, defaultModel: null } : null;
}
