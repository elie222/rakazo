import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

export class IsolationError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "IsolationError";
  }
}

/** Unique (spaceId, userId, name) collision when renaming a bot section. */
export class BotSectionNameConflictError extends Error {
  constructor(message = "Section name already used") {
    super(message);
    this.name = "BotSectionNameConflictError";
  }
}

/**
 * The actor for a request. Without a chosen Space, a session opens the organization it was
 * first given, which is the one the user was last active in, so its requests never drift
 * between organizations as runs finish elsewhere.
 */
export async function requireMembership(
  prisma: PrismaClient,
  userId: string,
  requestedSpaceId?: string | null,
  sessionId?: string,
): Promise<Actor> {
  const organizationId = requestedSpaceId
    ? null
    : await sessionOrganizationId(prisma, userId, sessionId);
  const membership = await prisma.spaceMember.findFirst({
    where: {
      userId,
      ...(requestedSpaceId ? { spaceId: requestedSpaceId } : {}),
      ...(organizationId ? { organizationId } : {}),
    },
    orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      userId: true,
      spaceId: true,
      member: { select: { user: { select: { email: true } } } },
    },
  });
  if (!membership) {
    throw new IsolationError("No personal space");
  }
  return {
    userId: membership.userId,
    spaceId: membership.spaceId,
    email: membership.member.user.email,
    isDeploymentOwner: false,
  };
}

async function sessionOrganizationId(
  prisma: PrismaClient,
  userId: string,
  sessionId: string | undefined,
): Promise<string | null> {
  return runAsSystem("pick the organization a session opens", async () => {
    const pinned = sessionId
      ? (
          await prisma.session.findUnique({
            where: { id: sessionId },
            select: { activeOrganizationId: true },
          })
        )?.activeOrganizationId
      : null;
    if (pinned) {
      const stillMember = await prisma.member.findFirst({
        where: { organizationId: pinned, userId },
        select: { id: true },
      });
      if (stillMember) return pinned;
    }
    const spaceId = await lastActiveSpaceId(prisma, userId);
    const organizationId = spaceId
      ? ((
          await prisma.space.findUnique({
            where: { id: spaceId },
            select: { organizationId: true },
          })
        )?.organizationId ?? null)
      : null;
    if (sessionId && organizationId) {
      await prisma.session.updateMany({
        where: { id: sessionId, userId },
        data: { activeOrganizationId: organizationId },
      });
    }
    return organizationId;
  });
}

/**
 * The Space of the user's latest finished run, for a client that has not picked one. One
 * index probe per membership, on the partial index that serves recent activity.
 */
async function lastActiveSpaceId(prisma: PrismaClient, userId: string): Promise<string | null> {
  const [latest] = await prisma.$queryRaw<Array<{ spaceId: string }>>`
      SELECT member."spaceId"
      FROM "space_members" AS member
      JOIN "spaces" AS space ON space."id" = member."spaceId" AND space."deletingAt" IS NULL
      CROSS JOIN LATERAL (
        SELECT run."completedAt"
        FROM "runs" AS run
        WHERE run."spaceId" = member."spaceId"
          AND run."userId" = member."userId"
          AND run."status" IN ('completed', 'failed', 'cancelled')
          AND run."trigger" NOT IN ('tickets')
          AND run."completedAt" IS NOT NULL
        ORDER BY run."completedAt" DESC
        LIMIT 1
      ) AS latest
      WHERE member."userId" = ${userId}
      ORDER BY latest."completedAt" DESC
      LIMIT 1`;
  return latest?.spaceId ?? null;
}

export function scoped<T extends { spaceId: string; userId?: string }>(
  actor: Actor,
  record: T | null,
): T {
  if (!record || record.spaceId !== actor.spaceId) {
    throw new IsolationError();
  }
  if (record.userId && record.userId !== actor.userId) {
    throw new IsolationError();
  }
  return record;
}
