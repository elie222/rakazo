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

export class CannotDeleteSpaceAsNonOwnerError extends Error {
  constructor() {
    super("Only the space owner can delete it");
    this.name = "CannotDeleteSpaceAsNonOwnerError";
  }
}

export class SpaceDeletionInProgressError extends Error {
  constructor() {
    super("Space deletion is already in progress");
    this.name = "SpaceDeletionInProgressError";
  }
}

export const SPACE_DELETION_CLAIM_TIMEOUT_MS = 5 * 60_000;

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

type EmptySpaceDeleteInput = {
  currentSpaceId: string;
  userId: string;
  spaceId: string;
};

/** Serialize content creation with the empty-space deletion claim. */
export async function lockSpaceForContentCreation(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; userId: string },
): Promise<{ organizationId: string }> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))::text AS "lock"
  `);
  const membership = await tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: {
      organizationId: true,
      space: { select: { deletingAt: true } },
    },
  });
  if (!membership) throw new IsolationError();
  if (membership.space.deletingAt) throw new SpaceDeletionInProgressError();
  return { organizationId: membership.organizationId };
}

async function lockSpaceDeletion(tx: Prisma.TransactionClient, spaceId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${spaceId}, 0))::text AS "lock"
  `);
}

type ClaimedSpaceDeleteInput = EmptySpaceDeleteInput & { claimId: string };

type SpaceDeleteDb = Pick<PrismaClient, "spaceMember" | "bot" | "chatGroup" | "computer">;

async function assertEmptySpaceDeletable(
  db: SpaceDeleteDb,
  input: EmptySpaceDeleteInput,
): Promise<{
  organizationId: string;
  memberships: Array<{
    spaceId: string;
    createdAt: Date;
    space: { isDefault: boolean };
  }>;
  computers: Array<{ homeKey: string; kind: string; providerRef: string }>;
}> {
  const currentMembership = await db.spaceMember.findUnique({
    where: {
      spaceId_userId: {
        spaceId: input.currentSpaceId,
        userId: input.userId,
      },
    },
    select: { organizationId: true },
  });
  if (!currentMembership) throw new IsolationError();
  const targetMembership = await db.spaceMember.findUnique({
    where: {
      spaceId_userId: {
        spaceId: input.spaceId,
        userId: input.userId,
      },
    },
    select: {
      organizationId: true,
      role: true,
      space: { select: { isDefault: true } },
    },
  });
  if (!targetMembership || targetMembership.organizationId !== currentMembership.organizationId) {
    throw new SpaceNotFoundError();
  }
  if (targetMembership.role !== "owner") throw new CannotDeleteSpaceAsNonOwnerError();
  if (targetMembership.space.isDefault) throw new CannotDeleteDefaultSpaceError();
  const memberships = await db.spaceMember.findMany({
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
    db.bot.count({ where: { spaceId: input.spaceId } }),
    db.chatGroup.count({ where: { spaceId: input.spaceId } }),
    db.computer.findMany({
      where: { spaceId: input.spaceId, providerRef: { not: null } },
      select: { homeKey: true, kind: true, providerRef: true },
    }),
  ]);
  if (botCount > 0 || groupCount > 0) throw new SpaceNotEmptyError();
  return {
    organizationId: currentMembership.organizationId,
    memberships,
    computers: computers.flatMap((computer) =>
      computer.providerRef
        ? [{ homeKey: computer.homeKey, kind: computer.kind, providerRef: computer.providerRef }]
        : [],
    ),
  };
}

/** Claim an empty Space before external teardown.
 *
 * Content creation takes the same advisory lock and rejects a claimed Space,
 * so no bot or group can appear after this emptiness check. A stale claim may
 * be retried after five minutes if a process exits. Takeover is safe because
 * provider destroy is idempotent (missing remotes succeed), every worker
 * verifies its claim token before and after each destroy, provider-handle
 * clearing is conditioned on the claim token, and no worker releases its
 * claim after external teardown starts — so content can never be unblocked
 * while an old destroy may still be in flight. */
export async function claimEmptySpaceDeletionForMember(
  prisma: PrismaClient,
  input: EmptySpaceDeleteInput,
): Promise<{
  claimId: string;
  recovered: boolean;
  computers: Array<{ homeKey: string; kind: string; providerRef: string }>;
}> {
  const claimId = randomUUID();
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const planned = await assertEmptySpaceDeletable(tx, input);
        const lifecycle = await tx.space.findUnique({
          where: { id: input.spaceId },
          select: { deletingAt: true },
        });
        const claimedBefore = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS);
        const claimed = await tx.space.updateMany({
          where: {
            id: input.spaceId,
            OR: [{ deletingAt: null }, { deletingAt: { lt: claimedBefore } }],
          },
          data: { deletingAt: new Date(), deletionClaimId: claimId },
        });
        if (claimed.count === 0) throw new SpaceDeletionInProgressError();
        return {
          claimId,
          recovered: Boolean(lifecycle?.deletingAt),
          computers: planned.computers,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Renew an active claim while provider teardown is in flight. */
export async function renewSpaceDeletionClaim(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<boolean> {
  const renewed = await prisma.space.updateMany({
    where: {
      id: input.spaceId,
      deletionClaimId: input.claimId,
      memberships: { some: { userId: input.userId, role: "owner" } },
    },
    data: { deletingAt: new Date() },
  });
  return renewed.count === 1;
}

/** Release only this caller's deletion claim after teardown or validation fails. */
export async function releaseSpaceDeletionClaim(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<void> {
  await prisma.space.updateMany({
    where: {
      id: input.spaceId,
      deletionClaimId: input.claimId,
      memberships: { some: { userId: input.userId, role: "owner" } },
    },
    data: { deletingAt: null, deletionClaimId: null },
  });
}

/** Delete an empty, non-default privacy boundary.
 *
 * Only the SpaceMember owner may delete, and only empty spaces: bots
 * (including archived) and groups would otherwise orphan sandbox computers and
 * files that `destroyBot` cleans up per bot. Callers must destroy any leftover
 * team sandboxes and clear those providerRefs before invoking this so a failed
 * `sandbox.destroy` cannot lose the only persisted handle, and a failed delete
 * cannot leave a stale ref to a destroyed sandbox. Callers should surface
 * `SpaceNotEmptyError` as "delete its bots and groups first" so an empty space
 * is always deletable in two steps without an onboarding trap. Returns the
 * space the client should switch to when the active space was deleted (the
 * current space when deleting another; otherwise the default, else the oldest
 * remaining). */
export async function deleteEmptySpaceForMember(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<{ id: string }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const claim = await tx.space.findFirst({
          where: { id: input.spaceId, deletionClaimId: input.claimId },
          select: { id: true },
        });
        if (!claim) throw new SpaceDeletionInProgressError();
        const planned = await assertEmptySpaceDeletable(tx, input);
        await tx.space.delete({ where: { id: input.spaceId } });
        if (input.spaceId !== input.currentSpaceId) {
          return { id: input.currentSpaceId };
        }
        const remaining = planned.memberships.filter(
          (membership) => membership.spaceId !== input.spaceId,
        );
        const fallback = remaining.find((membership) => membership.space.isDefault) ?? remaining[0];
        if (!fallback) throw new CannotDeleteLastSpaceError();
        return { id: fallback.spaceId };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
