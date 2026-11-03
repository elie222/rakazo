import { randomUUID } from "node:crypto";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { HomeDeletionReason } from "@rakazo/auth";
import { emailLocale, homeDeletionEmail } from "@rakazo/auth";
import type { PrismaClient } from "@rakazo/db";
import { hasModelAccess, needsBillingPortal, Prisma, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_ENDED_DAYS = 30;
const UNUSED_DAYS = 90;
const WARNING_DAYS = 7;
const CLAIM_MS = 15 * 60 * 1000;
const BATCH = 500;
/** A computer is only cleared while nothing runs on it. */
const IDLE_STATES = ["stopped", "suspended"];
const NO_CREDITS = { mode: null, balanceMicros: 0n, byokFreeUntil: null };

type Account = {
  billing: {
    status: string | null;
    subscribedAt: Date | null;
    endedAt: Date | null;
    currentPeriodEndsAt: Date | null;
    updatedAt: Date;
  } | null;
  modelCredits: { mode: string | null; balanceMicros: bigint; byokFreeUntil: Date | null } | null;
};
type Due = { at: Date; reason: HomeDeletionReason };
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * When a computer's saved home becomes due for deletion: 30 days after a paid plan ended, or
 * 90 days unused without one. Use since then moves it later. Null while the organization can
 * run bots (a plan, credits or a free period) or owes a payment.
 */
export function homeDeletionDue(account: Account, lastUsedAt: Date, now = new Date()): Due | null {
  if (planIsLive(account, now)) return null;
  const { billing } = account;
  if (billing?.subscribedAt) {
    const ended = billing.endedAt ?? billing.currentPeriodEndsAt ?? billing.updatedAt;
    return { at: addDays(latest(ended, lastUsedAt), PLAN_ENDED_DAYS), reason: "plan-ended" };
  }
  return { at: addDays(lastUsedAt, UNUSED_DAYS), reason: "unused" };
}

function planIsLive({ billing, modelCredits }: Account, now: Date) {
  const status = billing?.status ?? null;
  return needsBillingPortal(status) || hasModelAccess(modelCredits ?? NO_CREDITS, status, now);
}

const candidate = {
  homeStorageId: { not: null },
  kind: { not: "docker" },
} satisfies Prisma.ComputerWhereInput;

interface HomeRetentionDeps {
  prisma: PrismaClient;
  email: TransactionalEmailProvider;
  appUrl: string;
  onError: (error: unknown) => void;
}

/**
 * Deletes stored homes that are past retention, emailing each owner a week first. Every API
 * instance may run it: a claim keeps each email to one process, and eligibility is read again
 * right before each email and inside the deletion's transaction, so resubscribing or using a
 * bot in the meantime cancels it.
 *
 * Deleting clears the computer's pointer to its stored home and the key that decrypts it; the
 * worker's storage sweep then removes the unowned objects. The computer row and its provider
 * reference stay, so a provider that keeps its own disk resumes it; any other computer, or one
 * whose provider copy has expired, starts empty next time. Docker computers are skipped: they
 * work in a host's cached copy, which the stored home backs up.
 */
export function homeRetentionSweep(deps: HomeRetentionDeps): () => Promise<void> {
  return () =>
    runAsSystem("delete saved homes past retention", async () => {
      const { prisma } = deps;
      await prisma.homeDeletionNotice.deleteMany({
        where: { computer: { NOT: candidate }, ...claimable() },
      });
      const warnings = new Map<
        string,
        { userId: string; reason: HomeDeletionReason; ids: string[] }
      >();
      let cursor: string | undefined;
      for (;;) {
        const now = new Date();
        const computers = await dueDates(prisma, {}, now, cursor);
        for (const { id, userId, notice, due } of computers) {
          // The deletion keeps the date the email gave, unless something since moved it later.
          if (notice?.warnedAt && notice.deleteAfter && due && due.at <= notice.deleteAfter) {
            if (notice.deleteAfter <= now) await removeHome(prisma, id).catch(deps.onError);
            continue;
          }
          const warnable = due && due.at.getTime() <= now.getTime() + WARNING_DAYS * DAY_MS;
          // A claimed notice is another process's email in progress.
          if (notice && (notice.warnedAt || !warnable))
            await prisma.homeDeletionNotice.deleteMany({
              where: { computerId: id, ...claimable() },
            });
          if (!warnable) continue;
          const key = `${userId}:${due.reason}`;
          const group = warnings.get(key) ?? { userId, reason: due.reason, ids: [] };
          group.ids.push(id);
          warnings.set(key, group);
        }
        if (computers.length < BATCH) break;
        cursor = computers.at(-1)?.id;
      }
      // One at a time: a burst would trip the email provider's rate limit.
      for (const group of warnings.values()) await warn(deps, group).catch(deps.onError);
    });
}

/**
 * Each matching computer with a stored home and the date it is due for deletion now. A computer
 * that is running or starting counts as used now.
 */
async function dueDates(db: Db, where: Prisma.ComputerWhereInput, now: Date, cursor?: string) {
  const computers = await db.computer.findMany({
    where: { ...where, ...candidate },
    select: {
      id: true,
      userId: true,
      state: true,
      space: {
        select: {
          organization: {
            select: {
              billing: {
                select: {
                  status: true,
                  subscribedAt: true,
                  endedAt: true,
                  currentPeriodEndsAt: true,
                  updatedAt: true,
                },
              },
              modelCredits: { select: { mode: true, balanceMicros: true, byokFreeUntil: true } },
            },
          },
        },
      },
      homeDeletionNotice: { select: { warnedAt: true, deleteAfter: true } },
    },
    orderBy: { id: "asc" },
    take: BATCH,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  // Only computers that could be due need their history read.
  const used = await lastUsed(
    db,
    computers
      .filter(
        (computer) =>
          IDLE_STATES.includes(computer.state) && !planIsLive(computer.space.organization, now),
      )
      .map((computer) => computer.id),
  );
  return computers.map((computer) => {
    const usedAt = used.get(computer.id);
    return {
      id: computer.id,
      userId: computer.userId,
      notice: computer.homeDeletionNotice,
      due: usedAt ? homeDeletionDue(computer.space.organization, usedAt, now) : null,
    };
  });
}

/**
 * The latest of each computer's creation, its bots' latest runs, and its latest running stretch.
 * Each lookup reads one index entry, so the cost does not grow with run history.
 */
async function lastUsed(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, Date>();
  const rows = await db.$queryRaw<Array<{ id: string; at: Date }>>`
    SELECT c.id, GREATEST(
      c."createdAt",
      (SELECT max((SELECT max(r."createdAt") FROM runs r WHERE r."botId" = b.id))
        FROM bots b WHERE b."computerId" = c.id),
      (SELECT GREATEST(s."startedAt", s."endedAt", s."lastSeenAt") FROM computer_runs s
        WHERE s."computerId" = c.id ORDER BY s."startedAt" DESC LIMIT 1)
    ) AS at
    FROM computers c WHERE c.id IN (${Prisma.join(ids)})`;
  return new Map(rows.map((row) => [row.id, row.at]));
}

function claimable() {
  return { OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: new Date() } }] };
}

/**
 * Emails the owner once for all their computers still due for the same reason. A crash after
 * sending and before recording it sends again once the claim expires, so nothing is deleted
 * unwarned.
 */
async function warn(
  deps: HomeRetentionDeps,
  group: { userId: string; reason: HomeDeletionReason; ids: string[] },
) {
  const { prisma } = deps;
  await prisma.homeDeletionNotice.createMany({
    data: group.ids.map((computerId) => ({ computerId })),
    skipDuplicates: true,
  });
  const claimId = randomUUID();
  const claimed = await prisma.homeDeletionNotice.updateMany({
    where: { computerId: { in: group.ids }, warnedAt: null, ...claimable() },
    data: { claimId, claimExpiresAt: new Date(Date.now() + CLAIM_MS) },
  });
  if (!claimed.count) return;
  const release = () =>
    prisma.homeDeletionNotice.updateMany({
      where: { claimId },
      data: { claimId: null, claimExpiresAt: null },
    });
  try {
    // Read again now that the claim holds them: a plan or use since the scan cancels.
    const sentAt = new Date();
    const deleteAfter = addDays(sentAt, WARNING_DAYS);
    const due = (await dueDates(prisma, { homeDeletionNotice: { claimId } }, sentAt))
      .filter((computer) => computer.due?.reason === group.reason && computer.due.at <= deleteAfter)
      .map((computer) => computer.id);
    await prisma.homeDeletionNotice.deleteMany({ where: { claimId, computerId: { notIn: due } } });
    const user = due.length
      ? await prisma.user.findUnique({
          where: { id: group.userId },
          select: { email: true, name: true, locale: true },
        })
      : null;
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
    await prisma.homeDeletionNotice.updateMany({
      where: { claimId },
      data: { warnedAt: sentAt, deleteAfter, claimId: null, claimExpiresAt: null },
    });
  } catch (error) {
    await release();
    throw error;
  }
}

/**
 * Clears the computer's stored home in one transaction that locks the computer and its notice
 * and reads eligibility again, so a start, a run or a plan that lands first cancels it.
 */
async function removeHome(prisma: PrismaClient, computerId: string) {
  const removed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT c.id FROM computers c JOIN home_deletion_notices n ON n."computerId" = c.id
      WHERE c.id = ${computerId} FOR UPDATE`;
    const now = new Date();
    const [computer] = await dueDates(
      tx,
      { id: computerId, state: { in: IDLE_STATES }, maintenanceId: null },
      now,
    );
    const notice = computer?.notice;
    if (
      !computer?.due ||
      !notice?.warnedAt ||
      !notice.deleteAfter ||
      notice.deleteAfter > now ||
      computer.due.at > notice.deleteAfter
    )
      return false;
    await tx.computer.update({
      where: { id: computerId },
      data: {
        homeStorageId: null,
        homeStorageKey: null,
        homeStorageRevision: null,
        homeRevision: "empty",
        homeRevisionAt: null,
      },
    });
    await tx.homeDeletionNotice.delete({ where: { computerId } });
    return true;
  });
  if (removed) getLogger().info("home.retention.deleted", { "computer.id": computerId });
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

function latest(a: Date, b: Date) {
  return a > b ? a : b;
}
