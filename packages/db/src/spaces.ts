import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** Per member, per organization: one person cannot fan out unbounded boundaries. */
const MAX_SPACES_PER_MEMBER = 32;

export class SpaceLimitError extends Error {
  constructor() {
    super("Space limit reached");
    this.name = "SpaceLimitError";
  }
}

export class InvalidSpaceNameError extends Error {
  constructor() {
    super("Space name must be between 1 and 60 characters");
    this.name = "InvalidSpaceNameError";
  }
}

type SpaceClient = Pick<
  PrismaClient,
  | "space"
  | "spaceMember"
  | "spaceModelPreference"
  | "spaceVoicePreference"
  | "memoryDocument"
  | "notificationPreference"
>;

interface CreateSpaceInput {
  spaceId: string;
  spaceMembershipId: string;
  organizationId: string;
  userId: string;
  name: string;
  createdAt: Date;
}

async function createSpace(prisma: SpaceClient, input: CreateSpaceInput): Promise<void> {
  await prisma.space.create({
    data: {
      id: input.spaceId,
      organizationId: input.organizationId,
      name: input.name,
      createdByUserId: input.userId,
      createdAt: input.createdAt,
    },
  });
  await prisma.spaceMember.create({
    data: {
      id: input.spaceMembershipId,
      spaceId: input.spaceId,
      organizationId: input.organizationId,
      userId: input.userId,
      role: "owner",
      createdAt: input.createdAt,
    },
  });
}

async function createSpaceDefaults(
  prisma: SpaceClient,
  input: { spaceId: string; userId: string; memoryContent: string },
): Promise<void> {
  await prisma.memoryDocument.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
      scope: "user",
      path: "MEMORY.md",
      content: input.memoryContent,
    },
  });
  await prisma.notificationPreference.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
    },
  });
}

async function copyProviderPreferences(
  prisma: SpaceClient,
  input: { sourceSpaceId: string; targetSpaceId: string; userId: string; createdAt: Date },
): Promise<void> {
  const [modelPreferences, voicePreferences] = await Promise.all([
    prisma.spaceModelPreference.findMany({
      where: { spaceId: input.sourceSpaceId, userId: input.userId },
    }),
    prisma.spaceVoicePreference.findMany({
      where: { spaceId: input.sourceSpaceId, userId: input.userId },
    }),
  ]);
  await Promise.all([
    modelPreferences.length
      ? prisma.spaceModelPreference.createMany({
          data: modelPreferences.map((preference) => ({
            spaceId: input.targetSpaceId,
            userId: input.userId,
            credentialId: preference.credentialId,
            modelId: preference.modelId,
            isDefault: preference.isDefault,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          })),
        })
      : Promise.resolve(),
    voicePreferences.length
      ? prisma.spaceVoicePreference.createMany({
          data: voicePreferences.map((preference) => ({
            spaceId: input.targetSpaceId,
            userId: input.userId,
            credentialId: preference.credentialId,
            voiceId: preference.voiceId,
            isDefault: preference.isDefault,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          })),
        })
      : Promise.resolve(),
  ]);
}

/** Create a sibling privacy boundary for a member of the active organization. */
export async function createSpaceForMember(
  prisma: PrismaClient,
  input: {
    currentSpaceId: string;
    userId: string;
    name: string;
  },
): Promise<{ id: string; name: string }> {
  const name = input.name.trim();
  if (!name || name.length > 60) throw new InvalidSpaceNameError();
  const spaceId = randomUUID();
  const spaceMembershipId = randomUUID();
  const createdAt = new Date();

  await withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const currentMembership = await tx.spaceMember.findUnique({
          where: {
            spaceId_userId: {
              spaceId: input.currentSpaceId,
              userId: input.userId,
            },
          },
          select: { organizationId: true },
        });
        if (!currentMembership) throw new IsolationError();
        const count = await tx.spaceMember.count({
          where: {
            userId: input.userId,
            organizationId: currentMembership.organizationId,
          },
        });
        if (count >= MAX_SPACES_PER_MEMBER) throw new SpaceLimitError();
        await createSpace(tx, {
          spaceId,
          spaceMembershipId,
          organizationId: currentMembership.organizationId,
          userId: input.userId,
          name,
          createdAt,
        });
        await createSpaceDefaults(tx, {
          spaceId,
          userId: input.userId,
          memoryContent: "# Space memory\n\n",
        });
        await copyProviderPreferences(tx, {
          sourceSpaceId: input.currentSpaceId,
          targetSpaceId: spaceId,
          userId: input.userId,
          createdAt,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );

  return { id: spaceId, name };
}
