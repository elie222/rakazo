import type { PrismaClient } from "./client.js";
import { newestCredentialOrder } from "./model-credentials.js";

export const newestVoiceCredentialOrder = newestCredentialOrder;

type VoiceCredentialScope = { userId: string; spaceId: string };

export async function selectSpaceVoicePreference(
  prisma: Pick<PrismaClient, "spaceVoicePreference">,
  scope: VoiceCredentialScope,
  credentialId: string,
  voiceId: string,
) {
  await prisma.spaceVoicePreference.updateMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      isDefault: true,
      credentialId: { not: credentialId },
    },
    data: { isDefault: false },
  });
  return prisma.spaceVoicePreference.upsert({
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
      voiceId,
      isDefault: true,
    },
    update: { voiceId, isDefault: true },
  });
}

function withVoicePreference<
  T extends {
    credential: {
      id: string;
      userId: string;
      provider: string;
      secretId: string;
      createdAt: Date;
      updatedAt: Date;
    };
    isDefault: boolean;
    voiceId: string;
  },
>(preference: T) {
  return {
    ...preference.credential,
    isDefault: preference.isDefault,
    voiceId: preference.voiceId,
  };
}

export async function findDefaultVoiceCredential(
  prisma: PrismaClient,
  scope: VoiceCredentialScope,
) {
  const preference = await prisma.spaceVoicePreference.findFirst({
    where: { spaceId: scope.spaceId, userId: scope.userId, isDefault: true },
    include: { credential: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  return preference ? withVoicePreference(preference) : null;
}

export function findNewestUserVoiceCredential(
  prisma: PrismaClient,
  userId: string,
  provider: string,
) {
  return prisma.userVoiceCredential.findFirst({
    where: { userId, provider },
    orderBy: newestVoiceCredentialOrder,
  });
}

export async function findVoiceCredential(
  prisma: PrismaClient,
  scope: VoiceCredentialScope,
  provider: string,
) {
  const preference = await prisma.spaceVoicePreference.findFirst({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      credential: { provider },
    },
    include: { credential: true },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
  });
  if (preference) return withVoicePreference(preference);
  const credential = await findNewestUserVoiceCredential(prisma, scope.userId, provider);
  return credential ? { ...credential, isDefault: false, voiceId: "" } : null;
}
