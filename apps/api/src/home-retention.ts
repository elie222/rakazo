import { randomUUID } from "node:crypto";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { ObjectAgentHomeStore } from "@rakazo/adapters";
import type { HomeDeletionReason } from "@rakazo/auth";
import { emailLocale, homeDeletionEmail } from "@rakazo/auth";
import type { PrismaClient } from "@rakazo/db";
import { hasBillingAccess, needsBillingPortal, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_ENDED_DAYS = 30;
const UNUSED_DAYS = 90;
const WARNING_DAYS = 7;
const CLAIM_MS = 15 * 60 * 1000;
const BATCH = 500;
/** A computer is only cleared while nothing runs on it. */
const IDLE_STATES = ["stopped", "suspended"];

type BillingSnapshot = {
  status: string | null;
  subscribedAt: Date | null;
  endedAt: Date | null;
  currentPeriodEndsAt: Date | null;
  updatedAt: Date;
};

/**
 * When a computer's saved home becomes due for deletion: 30 days after a paid plan ended, or
 * 90 days unused without one. Use since then moves it later. Null while a plan is live.
 */
export function homeDeletionDue(
  account: BillingSnapshot | null,
  lastUsedAt: Date,
): { at: Date; reason: HomeDeletionReason } | null {
  if (account && (hasBillingAccess(account.status) || needsBillingPortal(account.status)))
    return null;
  if (account?.subscribedAt) {
    const ended = account.endedAt ?? account.currentPeriodEndsAt ?? account.updatedAt;
    return { at: addDays(latest(ended, lastUsedAt), PLAN_ENDED_DAYS), reason: "plan-ended" };
  }
  return { at: addDays(lastUsedAt, UNUSED_DAYS), reason: "unused" };
}

interface HomeRetentionDeps {
  prisma: PrismaClient;
  home: ObjectAgentHomeStore;
  email: TransactionalEmailProvider;
  appUrl: string;
  onError: (error: unknown) => void;
}

/**
 * Deletes stored homes that are past retention, emailing each owner a week first. Every API
 * instance may run it: notice claims keep one process per email or deletion, and eligibility is
 * checked again before each, so resubscribing or using a bot in the meantime cancels it.
 *
 * Only the stored copy goes. The computer row and its provider reference stay, so a provider that
 * keeps its own disk resumes it; any other computer, or one whose provider copy has expired, starts
 * empty next time.
 */
export function homeRetentionSweep(deps: HomeRetentionDeps): () => Promise<void> {
  return () =>
    runAsSystem("delete saved homes past retention", async () => {
      const now = new Date();
      await settleNotices(deps, now);
      const warnings = new Map<
        string,
        { userId: string; reason: HomeDeletionReason; ids: string[] }
      >();
      let cursor: string | undefined;
      for (;;) {
        const computers = await deps.prisma.computer.findMany({
          where: { homeStorageRevision: { not: null } },
          select: {
            id: true,
            userId: true,
            homeKey: true,
            homeStorageId: true,
            state: true,
            maintenanceId: true,
            createdAt: true,
            bots: { select: { id: true } },
            space: { select: { organization: { select: { billing: true } } } },
            homeDeletionNotice: { select: { warnedAt: true, deleteAfter: true } },
          },
          orderBy: { id: "asc" },
          take: BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        const used = await lastUsed(deps.prisma, computers);
        for (const computer of computers) {
          const due = homeDeletionDue(
            computer.space.organization.billing,
            used.get(computer.id) ?? computer.createdAt,
          );
          const notice = computer.homeDeletionNotice;
          // The deletion keeps the date the email gave, unless something since moved it later.
          if (notice?.warnedAt && notice.deleteAfter && due && due.at <= notice.deleteAfter) {
            if (
              notice.deleteAfter <= now &&
              IDLE_STATES.includes(computer.state) &&
              !computer.maintenanceId
            )
              await removeHome(deps, computer, now).catch(deps.onError);
            continue;
          }
          const warnable = due && due.at.getTime() <= now.getTime() + WARNING_DAYS * DAY_MS;
          // A claimed notice is another process's email or deletion in progress.
          if (notice && (notice.warnedAt || !warnable))
            await deps.prisma.homeDeletionNotice.deleteMany({
              where: { computerId: computer.id, ...claimable(now) },
            });
          if (!warnable) continue;
          const key = `${computer.userId}:${due.reason}`;
          const group = warnings.get(key) ?? {
            userId: computer.userId,
            reason: due.reason,
            ids: [],
          };
          group.ids.push(computer.id);
          warnings.set(key, group);
        }
        if (computers.length < BATCH) break;
        cursor = computers.at(-1)?.id;
      }
      // One at a time: a burst would trip the email provider's rate limit.
      for (const group of warnings.values()) await warn(deps, group, now).catch(deps.onError);
    });
}

/** The latest of each computer's creation, its bots' runs, and its own running stretches. */
async function lastUsed(
  prisma: PrismaClient,
  computers: ReadonlyArray<{ id: string; createdAt: Date; bots: ReadonlyArray<{ id: string }> }>,
) {
  const used = new Map<string, Date>();
  const bump = (computerId: string | undefined, at: Date | null | undefined) => {
    if (!computerId || !at) return;
    const seen = used.get(computerId);
    if (!seen || at > seen) used.set(computerId, at);
  };
  const computerOfBot = new Map(
    computers.flatMap((computer) => computer.bots.map((bot) => [bot.id, computer.id] as const)),
  );
  if (computerOfBot.size) {
    const runs = await prisma.run.groupBy({
      by: ["botId"],
      where: { botId: { in: [...computerOfBot.keys()] } },
      _max: { createdAt: true },
    });
    for (const run of runs) bump(computerOfBot.get(run.botId), run._max.createdAt);
  }
  if (computers.length) {
    const stretches = await prisma.computerRun.groupBy({
      by: ["computerId"],
      where: { computerId: { in: computers.map((computer) => computer.id) } },
      _max: { startedAt: true, endedAt: true },
    });
    for (const stretch of stretches) {
      bump(stretch.computerId, stretch._max.startedAt);
      bump(stretch.computerId, stretch._max.endedAt);
    }
  }
  for (const computer of computers) bump(computer.id, computer.createdAt);
  return used;
}

function claimable(now: Date) {
  return { OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: now } }] };
}

function claim(now: Date) {
  return { claimId: randomUUID(), claimExpiresAt: new Date(now.getTime() + CLAIM_MS) };
}

/**
 * Emails the owner once for all their computers due for the same reason. A crash after sending
 * and before recording it sends again once the claim expires, so nothing is deleted unwarned.
 */
async function warn(
  deps: HomeRetentionDeps,
  group: { userId: string; reason: HomeDeletionReason; ids: string[] },
  now: Date,
) {
  const { prisma } = deps;
  await prisma.homeDeletionNotice.createMany({
    data: group.ids.map((computerId) => ({ computerId })),
    skipDuplicates: true,
  });
  const lease = claim(now);
  const claimed = await prisma.homeDeletionNotice.updateMany({
    where: { computerId: { in: group.ids }, warnedAt: null, ...claimable(now) },
    data: lease,
  });
  if (!claimed.count) return;
  const release = () =>
    prisma.homeDeletionNotice.updateMany({
      where: { claimId: lease.claimId },
      data: { claimId: null, claimExpiresAt: null },
    });
  const deleteAfter = new Date(now.getTime() + WARNING_DAYS * DAY_MS);
  try {
    const user = await prisma.user.findUnique({
      where: { id: group.userId },
      select: { email: true, name: true, locale: true },
    });
    if (!user) {
      await release();
      return;
    }
    await deps.email.send(
      await homeDeletionEmail(
        user,
        deleteAfter,
        group.reason,
        deps.appUrl,
        emailLocale(user.locale),
      ),
    );
  } catch (error) {
    await release();
    throw error;
  }
  await prisma.homeDeletionNotice.updateMany({
    where: { claimId: lease.claimId },
    data: { warnedAt: now, deleteAfter, claimId: null, claimExpiresAt: null },
  });
}

/**
 * Records the stored home on the claimed notice, then clears the computer's pointer to it, so a
 * crash at any later step leaves a notice `settleNotices` finishes.
 */
async function removeHome(
  deps: HomeRetentionDeps,
  computer: { id: string; homeKey: string; homeStorageId: string | null },
  now: Date,
) {
  const { prisma } = deps;
  const storageId = computer.homeStorageId;
  if (!storageId) return;
  const lease = claim(now);
  const claimed = await prisma.homeDeletionNotice.updateMany({
    where: { computerId: computer.id, warnedAt: { not: null }, ...claimable(now) },
    data: { ...lease, storageId },
  });
  if (!claimed.count) return;
  // Without a saved revision a provider resumes its own copy, or starts the computer empty.
  const cleared = await prisma.computer.updateMany({
    where: {
      id: computer.id,
      state: { in: IDLE_STATES },
      maintenanceId: null,
      homeStorageId: storageId,
    },
    data: {
      homeStorageId: null,
      homeStorageKey: null,
      homeStorageRevision: null,
      homeRevision: "empty",
      homeRevisionAt: null,
    },
  });
  if (!cleared.count) {
    await prisma.homeDeletionNotice.updateMany({
      where: { claimId: lease.claimId },
      data: { claimId: null, claimExpiresAt: null, storageId: null },
    });
    return;
  }
  await finishRemoval(deps, computer.id, storageId, { claimId: lease.claimId });
}

async function finishRemoval(
  deps: HomeRetentionDeps,
  computerId: string,
  storageId: string,
  notice: Record<string, unknown>,
) {
  const computer = await deps.prisma.computer.findUnique({
    where: { id: computerId },
    select: { homeKey: true, homeStorageId: true, homeRevision: true, state: true },
  });
  // A computer started and saved since has a new home of its own; only the old objects go.
  if (
    computer &&
    !computer.homeStorageId &&
    computer.homeRevision === "empty" &&
    IDLE_STATES.includes(computer.state)
  )
    await deps.home.remove(computer.homeKey);
  await deps.home.removeStorage(storageId);
  await deps.prisma.homeDeletionNotice.deleteMany({ where: { computerId, ...notice } });
  getLogger().info("home.retention.deleted", { "computer.id": computerId });
}

/** Finishes deletions a crash interrupted, and drops notices for homes no longer stored. */
async function settleNotices(deps: HomeRetentionDeps, now: Date) {
  const notices = await deps.prisma.homeDeletionNotice.findMany({
    where: {
      ...claimable(now),
      AND: [
        {
          OR: [{ storageId: { not: null } }, { computer: { homeStorageRevision: null } }],
        },
      ],
    },
    select: {
      computerId: true,
      storageId: true,
      computer: { select: { homeStorageId: true, homeStorageRevision: true } },
    },
  });
  for (const { computerId, storageId, computer } of notices) {
    const unclaimed = { storageId, ...claimable(now) };
    if (storageId && storageId !== computer.homeStorageId)
      await finishRemoval(deps, computerId, storageId, unclaimed);
    else if (!computer.homeStorageRevision)
      await deps.prisma.homeDeletionNotice.deleteMany({ where: { computerId, ...unclaimed } });
  }
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

function latest(a: Date, b: Date) {
  return a > b ? a : b;
}
