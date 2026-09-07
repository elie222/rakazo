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

export class SpaceNotFoundError extends Error {
  constructor() {
    super("Space not found");
    this.name = "SpaceNotFoundError";
  }
}

export class CannotDeleteDefaultSpaceError extends Error {
  constructor() {
    super("The default space cannot be deleted");
    this.name = "CannotDeleteDefaultSpaceError";
  }
}

export class CannotDeleteLastSpaceError extends Error {
  constructor() {
    super("The last remaining space cannot be deleted");
    this.name = "CannotDeleteLastSpaceError";
  }
}

export class SpaceNotEmptyError extends Error {
  constructor() {
    super("Delete its bots and groups first");
    this.name = "SpaceNotEmptyError";
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
  | "bot"
  | "chatGroup"
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

/** Delete an empty, non-default privacy boundary.
 *
 * Only empty spaces can be removed: bots (including archived) and groups would
 * otherwise orphan sandbox computers and files that `destroyBot` cleans up per
 * bot. Team computers can outlive bots, so this returns any leftover computer
 * refs for the caller to `sandbox.destroy` after the row cascade. Callers
 * should surface `SpaceNotEmptyError` as "delete its bots and groups first" so
 * an empty space is always deletable in two steps without an onboarding trap.
 * Returns the space the client should switch to when the active space was
 * deleted (the default, else the oldest remaining). */
export async function deleteEmptySpaceForMember(
  prisma: PrismaClient,
  input: {
    currentSpaceId: string;
    userId: string;
    spaceId: string;
  },
): Promise<{
  id: string;
  orphanedComputers: Array<{ homeKey: string; kind: string; providerRef: string }>;
}> {
  return withTransactionRetry(() =>
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
        const targetMembership = await tx.spaceMember.findUnique({
          where: {
            spaceId_userId: {
              spaceId: input.spaceId,
              userId: input.userId,
            },
          },
          select: {
            organizationId: true,
            space: { select: { isDefault: true } },
          },
        });
        if (
          !targetMembership ||
          targetMembership.organizationId !== currentMembership.organizationId
        ) {
          throw new SpaceNotFoundError();
        }
        if (targetMembership.space.isDefault) throw new CannotDeleteDefaultSpaceError();
        const memberships = await tx.spaceMember.findMany({
          where: {
            userId: input.userId,
            organizationId: currentMembership.organizationId,
          },
          select: {
            spaceId: true,
            createdAt: true,
            space: { select: { isDefault: true } },
          },
          orderBy: { createdAt: "asc" },
        });
        if (memberships.length <= 1) throw new CannotDeleteLastSpaceError();
        const [botCount, groupCount, computers] = await Promise.all([
          tx.bot.count({ where: { spaceId: input.spaceId } }),
          tx.chatGroup.count({ where: { spaceId: input.spaceId } }),
          tx.computer.findMany({
            where: { spaceId: input.spaceId, providerRef: { not: null } },
            select: { homeKey: true, kind: true, providerRef: true },
          }),
        ]);
        if (botCount > 0 || groupCount > 0) throw new SpaceNotEmptyError();
        await tx.space.delete({ where: { id: input.spaceId } });
        const remaining = memberships.filter((membership) => membership.spaceId !== input.spaceId);
        const fallback = remaining.find((membership) => membership.space.isDefault) ?? remaining[0];
        if (!fallback) throw new CannotDeleteLastSpaceError();
        return {
          id: fallback.spaceId,
          orphanedComputers: computers.flatMap((computer) =>
            computer.providerRef
              ? [
                  {
                    homeKey: computer.homeKey,
                    kind: computer.kind,
                    providerRef: computer.providerRef,
                  },
                ]
              : [],
          ),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
