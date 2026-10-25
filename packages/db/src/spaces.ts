import { randomUUID } from "node:crypto";
import { displayName } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
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
    super("Space name must be readable and between 1 and 60 characters");
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

export class CannotDeleteSpaceAsNonOwnerError extends Error {
  constructor() {
    super("Only the space owner can delete it");
    this.name = "CannotDeleteSpaceAsNonOwnerError";
  }
}

export class CannotRenameSpaceAsNonOwnerError extends Error {
  constructor() {
    super("Only the space owner can rename it");
    this.name = "CannotRenameSpaceAsNonOwnerError";
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
  | "spaceModelRoleChoice"
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
  const [modelPreferences, modelRoleChoices, voicePreferences] = await Promise.all([
    prisma.spaceModelPreference.findMany({
      where: { spaceId: input.sourceSpaceId, userId: input.userId },
    }),
    prisma.spaceModelRoleChoice.findMany({
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
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          })),
        })
      : Promise.resolve(),
    modelRoleChoices.length
      ? prisma.spaceModelRoleChoice.createMany({
          data: modelRoleChoices.map((choice) => ({ ...choice, spaceId: input.targetSpaceId })),
        })
      : Promise.resolve(),
    voicePreferences.length
      ? prisma.spaceVoicePreference.createMany({
          data: voicePreferences.map((preference) => ({
            spaceId: input.targetSpaceId,
            userId: input.userId,
            credentialId: preference.credentialId,
            voiceId: preference.voiceId,
            speechModel: preference.speechModel,
            isDefault: preference.isDefault,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          })),
        })
      : Promise.resolve(),
  ]);
}

function normalizeSpaceName(name: string): string {
  const trimmed = name.trim();
  if (!displayName(trimmed, "") || trimmed.length > 60) throw new InvalidSpaceNameError();
  return trimmed;
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
  const name = normalizeSpaceName(input.name);
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

type SpaceMemberTargetInput = {
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

type ClaimedSpaceDeleteInput = SpaceMemberTargetInput & { claimId: string };

async function loadActorSpace(
  db: Pick<PrismaClient, "spaceMember">,
  input: SpaceMemberTargetInput,
) {
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
      space: { select: { isDefault: true, deletingAt: true } },
    },
  });
  if (!targetMembership || targetMembership.organizationId !== currentMembership.organizationId) {
    throw new SpaceNotFoundError();
  }
  return {
    organizationId: currentMembership.organizationId,
    role: targetMembership.role,
    isDefault: targetMembership.space.isDefault,
    deletingAt: targetMembership.space.deletingAt,
  };
}

/** Owner of a non-default Space that is not their last one in the organization. */
async function assertSpaceDeletable(
  db: Pick<PrismaClient, "spaceMember">,
  input: SpaceMemberTargetInput,
): Promise<Array<{ spaceId: string; space: { isDefault: boolean } }>> {
  const owned = await loadActorSpace(db, input);
  if (owned.role !== "owner") throw new CannotDeleteSpaceAsNonOwnerError();
  if (owned.isDefault) throw new CannotDeleteDefaultSpaceError();
  const memberships = await db.spaceMember.findMany({
    where: {
      userId: input.userId,
      organizationId: owned.organizationId,
    },
    select: { spaceId: true, space: { select: { isDefault: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length <= 1) throw new CannotDeleteLastSpaceError();
  return memberships;
}

/** Claim a Space before tearing down its content.
 *
 * Bot and group creation take the same advisory lock and reject a claimed
 * Space, so once claimed the Space only loses content. A stale claim may be
 * retried after five minutes if a process exits; the retry resumes teardown
 * where the previous worker stopped. Takeover is safe because bot and provider
 * destroy are idempotent (missing remotes succeed), every worker verifies its
 * claim token before and after each destroy, provider-handle clearing is
 * conditioned on the claim token, and no worker releases its claim after
 * destructive teardown starts — so content can never be unblocked while an
 * old destroy may still be in flight. */
export async function claimSpaceDeletionForMember(
  prisma: PrismaClient,
  input: SpaceMemberTargetInput,
): Promise<{ claimId: string; recovered: boolean }> {
  const claimId = randomUUID();
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        await assertSpaceDeletable(tx, input);
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
        return { claimId, recovered: Boolean(lifecycle?.deletingAt) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Every bot of a claimed Space, archived and other members' included, for per-bot teardown. */
export async function listClaimedSpaceBots(
  prisma: Pick<PrismaClient, "bot">,
  input: ClaimedSpaceDeleteInput,
) {
  return prisma.bot.findMany({
    where: { spaceId: input.spaceId, space: { deletionClaimId: input.claimId } },
    select: {
      id: true,
      userId: true,
      spaceId: true,
      name: true,
      archivedAt: true,
      computerId: true,
      webhookSecretId: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

/** Sandboxes still provisioned in a claimed Space once its bots are gone (team computers). */
export async function listClaimedSpaceComputers(
  prisma: Pick<PrismaClient, "computer">,
  input: ClaimedSpaceDeleteInput,
): Promise<Array<{ homeKey: string; kind: string; providerRef: string }>> {
  const computers = await prisma.computer.findMany({
    where: {
      spaceId: input.spaceId,
      providerRef: { not: null },
      space: { deletionClaimId: input.claimId },
    },
    select: { homeKey: true, kind: true, providerRef: true },
  });
  return computers.flatMap((computer) =>
    computer.providerRef
      ? [{ homeKey: computer.homeKey, kind: computer.kind, providerRef: computer.providerRef }]
      : [],
  );
}

/** Renew an active claim while teardown is in flight. */
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

/** Release only this caller's deletion claim when nothing has been torn down yet. */
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

/** Delete a claimed, non-default Space and everything left in it.
 *
 * Callers must first destroy every bot (`destroyBot` owns sandboxes, files,
 * sessions and artifacts per bot) and every leftover sandbox, clearing its
 * providerRef, so a failed external destroy never loses the only persisted
 * handle. Rows that remain (groups, threads, memories, routines, connections,
 * preferences, memberships, ...) go with the Space by cascade. Returns the
 * stored artifacts and computer homes the caller removes after commit, and
 * the space the client should switch to when the active space was deleted
 * (the current space when deleting another; otherwise the default, else the
 * oldest remaining). */
export async function deleteClaimedSpaceForMember(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<{ id: string; artifactKeys: string[]; homeKeys: string[] }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const claim = await tx.space.findFirst({
          where: { id: input.spaceId, deletionClaimId: input.claimId },
          select: { id: true },
        });
        if (!claim) throw new SpaceDeletionInProgressError();
        const memberships = await assertSpaceDeletable(tx, input);
        const [remainingBots, provisioned, artifacts, computers] = await Promise.all([
          tx.bot.count({ where: { spaceId: input.spaceId } }),
          tx.computer.count({ where: { spaceId: input.spaceId, providerRef: { not: null } } }),
          tx.artifact.findMany({
            where: { spaceId: input.spaceId },
            select: { storageKey: true },
          }),
          tx.computer.findMany({ where: { spaceId: input.spaceId }, select: { homeKey: true } }),
        ]);
        // Content creation is blocked while claimed, so this only trips when teardown
        // was cut short; a retry finishes it.
        if (remainingBots > 0 || provisioned > 0) throw new SpaceDeletionInProgressError();
        await tx.space.delete({ where: { id: input.spaceId } });
        const removed = {
          artifactKeys: artifacts.map((artifact) => artifact.storageKey),
          homeKeys: computers.map((computer) => computer.homeKey),
        };
        if (input.spaceId !== input.currentSpaceId) {
          return { id: input.currentSpaceId, ...removed };
        }
        const remaining = memberships.filter((membership) => membership.spaceId !== input.spaceId);
        const fallback = remaining.find((membership) => membership.space.isDefault) ?? remaining[0];
        if (!fallback) throw new CannotDeleteLastSpaceError();
        return { id: fallback.spaceId, ...removed };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Rename a space the caller owns in the active organization. */
export async function renameSpaceForMember(
  prisma: PrismaClient,
  input: SpaceMemberTargetInput & { name: string },
): Promise<{ id: string; name: string }> {
  const name = normalizeSpaceName(input.name);
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const owned = await loadActorSpace(tx, input);
        if (owned.role !== "owner") throw new CannotRenameSpaceAsNonOwnerError();
        if (owned.deletingAt) throw new SpaceDeletionInProgressError();
        await tx.space.update({
          where: { id: input.spaceId },
          data: { name },
        });
        return { id: input.spaceId, name };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
