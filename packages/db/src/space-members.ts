import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isOwnerRole } from "./billing.js";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { computerScopeKey } from "./computers.js";
import { appendEventInTransaction, createPendingSteeringRun } from "./events.js";
import type { RunTeardownTarget } from "./groups.js";
import { snapshotRunTeardownTargets } from "./groups.js";
import { runAsSystem } from "./row-security.js";
import { lockSpaceDeletion, personalOrganizationIds, SpaceNotFoundError } from "./spaces.js";
import { activeRunStatuses } from "./thread-listing.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const SPACE_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Owner-only actions. `code` lets an RPC boundary answer FORBIDDEN as-is. */
export class SpaceOwnerRequiredError extends Error {
  readonly code = "FORBIDDEN";
  constructor() {
    super("Only the space owner can do that");
    this.name = "SpaceOwnerRequiredError";
  }
}

/** One answer for unknown, expired, and used links, so none can be told apart. */
export class SpaceInviteNotFoundError extends Error {
  constructor() {
    super("This invite link is invalid or has expired");
    this.name = "SpaceInviteNotFoundError";
  }
}

export class SpaceMemberNotFoundError extends Error {
  constructor() {
    super("Member not found");
    this.name = "SpaceMemberNotFoundError";
  }
}

export class CannotRemoveSpaceOwnerError extends Error {
  constructor() {
    super("The space owner cannot be removed");
    this.name = "CannotRemoveSpaceOwnerError";
  }
}

export class SpaceOwnerCannotLeaveError extends Error {
  constructor() {
    super("The space owner cannot leave; delete the space instead");
    this.name = "SpaceOwnerCannotLeaveError";
  }
}

type SpaceRef = { spaceId: string; userId: string };

/**
 * What a departure stopped. The caller cancels the runs' jobs, tears down their
 * screens, then expires their leases, as after archiving a group.
 */
export type SpaceDeparture = {
  organizationId: string;
  cancelledRunIds: string[];
  /** Runs queued for other members' follow-ups that waited behind a cancelled run. */
  continuationRunIds: string[];
  computers: RunTeardownTarget[];
  /** Newest run.cancelled seq per thread, for realtime fanout. */
  events: Array<{ threadId: string; seq: number }>;
};

export async function requireSpaceOwner(
  db: Pick<PrismaClient, "spaceMember">,
  input: SpaceRef,
): Promise<void> {
  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: { role: true },
  });
  if (!membership || !isOwnerRole(membership.role)) throw new SpaceOwnerRequiredError();
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function listSpaceMembers(
  prisma: PrismaClient,
  input: SpaceRef,
): Promise<{
  spaceName: string;
  members: Array<{
    userId: string;
    name: string;
    email: string;
    image: string | null;
    role: "owner" | "member";
  }>;
  canManage: boolean;
}> {
  const rows = await prisma.spaceMember.findMany({
    where: { spaceId: input.spaceId },
    select: {
      userId: true,
      role: true,
      space: { select: { name: true } },
      member: { select: { user: { select: { name: true, email: true, image: true } } } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const self = rows.find((row) => row.userId === input.userId);
  if (!self) throw new SpaceNotFoundError();
  const members = rows
    .map((row) => ({
      userId: row.userId,
      name: row.member.user.name,
      email: row.member.user.email,
      image: row.member.user.image,
      role: isOwnerRole(row.role) ? ("owner" as const) : ("member" as const),
    }))
    .sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner"));
  return { spaceName: self.space.name, members, canManage: isOwnerRole(self.role) };
}

/** A new single-use link. Only its SHA-256 is stored; the token is returned once. */
export async function createSpaceInvite(
  prisma: PrismaClient,
  input: SpaceRef,
): Promise<{ token: string; expiresAt: Date }> {
  await requireSpaceOwner(prisma, input);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SPACE_INVITE_TTL_MS);
  await prisma.spaceInvite.create({
    data: {
      spaceId: input.spaceId,
      tokenHash: hashInviteToken(token),
      createdByUserId: input.userId,
      expiresAt,
    },
  });
  return { token, expiresAt };
}

type InviteRow = {
  id: string;
  spaceId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
  createdBy: { name: string };
  space: { name: string; organizationId: string; isDefault: boolean; deletingAt: Date | null };
};

async function findInvite(
  db: Pick<PrismaClient, "spaceInvite" | "spaceMember">,
  token: string,
  userId: string,
): Promise<{ invite: InviteRow; alreadyMember: boolean }> {
  const invite = await db.spaceInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: {
      id: true,
      spaceId: true,
      expiresAt: true,
      acceptedAt: true,
      acceptedByUserId: true,
      createdBy: { select: { name: true } },
      space: {
        select: { name: true, organizationId: true, isDefault: true, deletingAt: true },
      },
    },
  });
  if (!invite || invite.space.deletingAt) throw new SpaceInviteNotFoundError();
  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: invite.spaceId, userId } },
    select: { id: true },
  });
  const alreadyMember = membership !== null;
  const open = invite.acceptedAt === null && invite.expiresAt > new Date();
  // The person who used a link can reopen it while they still belong to the space.
  const usedBySelf = invite.acceptedByUserId === userId && alreadyMember;
  if (!open && !usedBySelf) throw new SpaceInviteNotFoundError();
  return { invite, alreadyMember };
}

export async function previewSpaceInvite(
  prisma: PrismaClient,
  input: { token: string; userId: string },
): Promise<{ spaceId: string; spaceName: string; inviterName: string; alreadyMember: boolean }> {
  const { invite, alreadyMember } = await findInvite(prisma, input.token, input.userId);
  return {
    spaceId: invite.spaceId,
    spaceName: invite.space.name,
    inviterName: invite.createdBy.name,
    alreadyMember,
  };
}

/**
 * Join the space a link points at. Claiming the link and adding the member
 * commit together, so a link is used at most once. Opening a link to a space
 * the person already belongs to leaves the link unused.
 */
export async function acceptSpaceInvite(
  prisma: PrismaClient,
  input: { token: string; userId: string },
): Promise<{ spaceId: string; organizationId: string; joined: boolean }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const { invite, alreadyMember } = await findInvite(tx, input.token, input.userId);
        const result = { spaceId: invite.spaceId, organizationId: invite.space.organizationId };
        if (alreadyMember) return { ...result, joined: false };
        await lockSpaceDeletion(tx, invite.spaceId);
        const now = new Date();
        const claimed = await tx.spaceInvite.updateMany({
          where: { id: invite.id, acceptedAt: null, expiresAt: { gt: now } },
          data: { acceptedAt: now, acceptedByUserId: input.userId },
        });
        const space = await tx.space.findUnique({
          where: { id: invite.spaceId },
          select: { deletingAt: true },
        });
        if (claimed.count !== 1 || !space || space.deletingAt) throw new SpaceInviteNotFoundError();

        const organizationId = invite.space.organizationId;
        const existing = await tx.member.findUnique({
          where: { organizationId_userId: { organizationId, userId: input.userId } },
          select: { id: true },
        });
        if (!existing) {
          const memberId = randomUUID();
          await tx.member.create({
            data: {
              id: memberId,
              organizationId,
              userId: input.userId,
              role: "member",
              createdAt: now,
            },
          });
          // A database trigger adds every new organization member to its default
          // Space. An invite opens one Space only, so undo that for any other.
          if (!invite.space.isDefault) {
            await tx.spaceMember.deleteMany({
              where: { id: `default-space-member:${memberId}`, userId: input.userId },
            });
          }
        }
        await tx.spaceMember.upsert({
          where: { spaceId_userId: { spaceId: invite.spaceId, userId: input.userId } },
          create: {
            id: randomUUID(),
            spaceId: invite.spaceId,
            organizationId,
            userId: input.userId,
            role: "member",
            createdAt: now,
          },
          update: {},
        });
        return { ...result, joined: true };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Owner only. The removed person's bots, chats and routines stay with the space. */
export async function removeSpaceMember(
  prisma: PrismaClient,
  input: SpaceRef & { memberUserId: string },
): Promise<SpaceDeparture> {
  await requireSpaceOwner(prisma, input);
  const target = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.memberUserId } },
    select: { role: true },
  });
  if (!target) throw new SpaceMemberNotFoundError();
  if (input.memberUserId === input.userId || isOwnerRole(target.role)) {
    throw new CannotRemoveSpaceOwnerError();
  }
  return departSpace(prisma, { spaceId: input.spaceId, userId: input.memberUserId });
}

/** Members only; an owner deletes the space instead. */
export async function leaveSpace(prisma: PrismaClient, input: SpaceRef): Promise<SpaceDeparture> {
  const membership = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: { role: true },
  });
  if (!membership) throw new SpaceNotFoundError();
  if (isOwnerRole(membership.role)) throw new SpaceOwnerCannotLeaveError();
  return departSpace(prisma, input);
}

/**
 * Before deleting an account: leave every Space in organizations the user does
 * not own, so what they made there passes to each Space's owner, and return the
 * organizations they own, which go with the account (shared Spaces included).
 */
export async function prepareAccountDeletion(
  prisma: PrismaClient,
  userId: string,
): Promise<{ ownedOrganizationIds: string[] }> {
  const memberships = await prisma.spaceMember.findMany({
    where: { userId },
    select: { spaceId: true, role: true, member: { select: { role: true } } },
  });
  for (const membership of memberships) {
    // A Space they own has nobody to hand it to; it goes with the account.
    if (isOwnerRole(membership.member.role) || isOwnerRole(membership.role)) continue;
    await departSpace(prisma, { spaceId: membership.spaceId, userId });
  }
  return { ownedOrganizationIds: await personalOrganizationIds(prisma, userId) };
}

/**
 * Take one person out of a Space. What they made there for everyone (bots,
 * chats, routines, sections) passes to the Space's owner, so nothing keeps
 * running with the credentials of someone who left. What was theirs alone
 * (credentials, connections, MCP servers, approval rules, preferences) is
 * deleted. Their organization membership goes too once no Space there is left.
 * Their unfinished runs there are cancelled: those run with their accounts.
 */
async function departSpace(prisma: PrismaClient, input: SpaceRef): Promise<SpaceDeparture> {
  const { spaceId, userId } = input;
  // Bots, routines and credentials are tenant rows; this moves them between people.
  return runAsSystem("move a departing member's Space content to its owner", () =>
    withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await lockSpaceDeletion(tx, spaceId);
          const departing = await tx.spaceMember.findUnique({
            where: { spaceId_userId: { spaceId, userId } },
            select: { id: true, organizationId: true },
          });
          if (!departing) throw new SpaceMemberNotFoundError();
          const owners = await tx.spaceMember.findMany({
            where: { spaceId, userId: { not: userId } },
            select: { userId: true, role: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          });
          const ownerId = owners.find((member) => isOwnerRole(member.role))?.userId;
          if (!ownerId) throw new CannotRemoveSpaceOwnerError();

          const runs = await tx.run.findMany({
            where: { spaceId, userId, status: { in: activeRunStatuses } },
            select: {
              id: true,
              taskId: true,
              threadId: true,
              botId: true,
              userId: true,
              spaceId: true,
            },
          });
          const cancelledRunIds = runs.map((run) => run.id);
          // Snapshot before cancelling: an expired lease still names the run's screen.
          const { targets } = await snapshotRunTeardownTargets(tx, cancelledRunIds);
          await cancelRunsInTransaction(tx, runs, new Date());
          const latestSeq = new Map<string, number>();
          if (runs.length) {
            await tx.event.deleteMany({
              where: { type: "thread.progress", runId: { in: cancelledRunIds } },
            });
            for (const run of runs) {
              const event = await appendEventInTransaction(tx, {
                spaceId,
                threadId: run.threadId,
                botId: run.botId,
                runId: run.id,
                type: "run.cancelled",
                payload: {},
              });
              latestSeq.set(run.threadId, event.seq);
            }
          }
          // Queued follow-ups would otherwise start a run as them.
          await tx.steeringMessage.deleteMany({ where: { userId, bot: { spaceId } } });
          // Others' follow-ups that waited behind a cancelled run start now, as they would
          // once it finished.
          const continuationRunIds: string[] = [];
          const waiting = new Map(
            runs.map(({ threadId, botId }) => [`${threadId}:${botId}`, { threadId, botId }]),
          );
          for (const thread of waiting.values()) {
            const id = await createPendingSteeringRun(tx, { spaceId, ...thread });
            if (id) continuationRunIds.push(id);
          }

          await moveSections(tx, { spaceId, fromUserId: userId, toUserId: ownerId });
          const reassign = { where: { spaceId, userId }, data: { userId: ownerId } };
          await tx.bot.updateMany(reassign);
          await tx.chatGroup.updateMany(reassign);
          // Their computers go with the bots, so the computer limit counts them for the owner.
          await tx.computer.updateMany(reassign);
          // A team computer is found by its person; retire that key so someone who rejoins
          // gets a computer of their own. The home key, and with it the files, stays.
          // Dedicated computers are found by their bot, so their key stays as it is.
          const teamComputer = await tx.computer.findUnique({
            where: { scopeKey: computerScopeKey({ mode: "team", spaceId, userId }) },
            select: { id: true },
          });
          if (teamComputer) {
            await tx.computer.update({
              where: { id: teamComputer.id },
              data: { scopeKey: `transferred:${teamComputer.id}` },
            });
          }
          // Paused: the owner's accounts must not start running someone else's prompt unasked.
          await tx.routine.updateMany({
            where: { spaceId, userId },
            // A watch restarts from the owner's accounts, not the departed person's results.
            data: { userId: ownerId, active: false, nextRunAt: null, watchState: Prisma.DbNull },
          });

          const own = { spaceId, userId };
          await tx.botSecret.deleteMany({ where: own });
          // Their vault for this Space only; the account vault every Space uses stays theirs.
          await tx.vaultCredential.deleteMany({ where: own });
          await tx.botMcpServer.deleteMany({
            where: { spaceId, OR: [{ userId }, { server: { userId } }] },
          });
          // What they made available in other Spaces of theirs keeps working there.
          const onlyHere = {
            ...own,
            allSpaces: false,
            availableIn: { none: { spaceId: { not: spaceId } } },
          };
          await tx.mcpServer.deleteMany({ where: onlyHere });
          await tx.capabilityInstall.deleteMany({ where: onlyHere });
          await tx.mcpServerSpace.deleteMany({ where: own });
          await tx.capabilityInstallSpace.deleteMany({ where: own });
          await tx.agentSkillSpace.deleteMany({ where: own });
          await tx.mcpOAuthSession.deleteMany({ where: own });
          await tx.modelOAuthSession.deleteMany({ where: own });
          await tx.connection.deleteMany({ where: own });
          await tx.messagingIdentity.deleteMany({ where: own });
          await tx.messagingLinkCode.deleteMany({ where: own });
          await tx.messagingInstallation.deleteMany({ where: own });
          await tx.messagingInstallSession.deleteMany({ where: own });
          await tx.actionApprovalRule.deleteMany({ where: { spaceId, createdByUserId: userId } });
          await tx.actionAutoReviewPreference.deleteMany({ where: own });
          await tx.notificationPreference.deleteMany({ where: own });
          await tx.secret.deleteMany({ where: own });
          // Model, voice and role preferences, setting overrides and AI consents cascade from here.
          await tx.spaceMember.delete({ where: { id: departing.id } });
          await tx.member.deleteMany({
            where: {
              organizationId: departing.organizationId,
              userId,
              spaceMemberships: { none: {} },
            },
          });
          return {
            organizationId: departing.organizationId,
            cancelledRunIds,
            continuationRunIds,
            computers: targets,
            events: [...latestSeq].map(([threadId, seq]) => ({ threadId, seq })),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ),
  );
}

/** Sections are unique per (space, person, name): merge into the owner's same-named one. */
async function moveSections(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; fromUserId: string; toUserId: string },
): Promise<void> {
  const [moving, kept] = await Promise.all([
    tx.botSection.findMany({
      where: { spaceId: input.spaceId, userId: input.fromUserId },
      select: { id: true, name: true },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
    tx.botSection.findMany({
      where: { spaceId: input.spaceId, userId: input.toUserId },
      select: { id: true, name: true, position: true },
    }),
  ]);
  const keptByName = new Map(kept.map((section) => [section.name, section.id]));
  let position = Math.max(-1, ...kept.map((section) => section.position));
  for (const section of moving) {
    const target = keptByName.get(section.name);
    if (target) {
      await tx.bot.updateMany({ where: { sectionId: section.id }, data: { sectionId: target } });
      await tx.chatGroup.updateMany({
        where: { sectionId: section.id },
        data: { sectionId: target },
      });
      await tx.botSection.delete({ where: { id: section.id } });
    } else {
      position += 1;
      await tx.botSection.update({
        where: { id: section.id },
        data: { userId: input.toUserId, position },
      });
    }
  }
}
