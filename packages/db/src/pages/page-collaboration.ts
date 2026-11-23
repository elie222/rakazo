import { bestEffort } from "@rakazo/logging";
import type { PrismaClient } from "../database/client.js";
import { retryWhileDatabaseUnavailable } from "../database/database-outage.js";
import { runAsSystem } from "../database/row-security.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ThreadEvents } from "../threads/events.js";

export const pageChangesScope = (userId: string) => `pages:${userId}`;

/** Longer than the model calls and the queue's backoff, including finalization attempts. */
export function pageRevisionPendingCutoff() {
  return new Date(Date.now() - 30 * 60_000);
}

export async function signalPageUsers(events: ThreadEvents, userIds: readonly (string | null)[]) {
  await Promise.all(
    [...new Set(userIds)]
      .filter((id) => id !== null)
      .map((id) => events.publishSpaceChange?.(pageChangesScope(id), "pages")),
  );
}

export async function signalPage(
  prisma: PrismaClient,
  events: ThreadEvents,
  pageId: string,
  formerUsers: readonly string[] = [],
) {
  if (!events.publishSpaceChange) return;
  await bestEffort(
    "signal page reviewers",
    (async () => {
      const page = await runAsSystem("find recipients of a page change", () =>
        retryWhileDatabaseUnavailable(
          () =>
            prisma.page.findUnique({
              where: { id: pageId },
              select: {
                userId: true,
                grants: {
                  where: { page: { visibility: "people" }, user: verifiedPageAccount },
                  select: { userId: true },
                },
              },
            }),
          { source: "page signal", waitMs: 15_000 },
        ),
      );
      await signalPageUsers(events, [
        ...formerUsers,
        ...(page ? [page.userId, ...page.grants.map(({ userId }) => userId)] : []),
      ]);
    })(),
  );
}

/** Serialize collaboration writes with page saves, visibility changes, and each other. */
export async function lockPage(tx: Prisma.TransactionClient, pageId: string) {
  await tx.$queryRaw`SELECT "id" FROM "pages" WHERE "id" = ${pageId} FOR UPDATE`;
}

export const activePageAccount = { deactivatedAt: null };
export const verifiedPageAccount = { ...activePageAccount, emailVerified: true };

export const pageRevisionBotSelect = {
  user: { select: { deactivatedAt: true } },
  bot: { select: { id: true, spaceId: true, archivedAt: true } },
} satisfies Prisma.PageSelect;

export async function canPageRequestRevision(
  tx: Prisma.TransactionClient,
  page: Prisma.PageGetPayload<{
    select: typeof pageRevisionBotSelect & { spaceId: true; userId: true };
  }>,
) {
  if (
    page.user.deactivatedAt ||
    !page.bot ||
    page.bot.archivedAt ||
    page.bot.spaceId !== page.spaceId
  )
    return false;
  return Boolean(
    await tx.spaceMember.findFirst({
      where: { spaceId: page.spaceId, userId: page.userId },
      select: { userId: true },
    }),
  );
}

export const pageOwnerWhere = ({
  userId,
  spaceId,
}: {
  userId: string;
  spaceId: string;
}): Prisma.PageWhereInput => ({
  userId,
  spaceId,
  user: activePageAccount,
  space: { memberships: { some: { userId } } },
});

/** With the page locked, discard work authorized by the revoked grant before it can be published. */
export async function cancelPageGrantRequests(tx: Prisma.TransactionClient, grantIds: string[]) {
  if (!grantIds.length) return;
  await tx.pageRevisionRequest.updateMany({
    where: { grantId: { in: grantIds }, status: { in: ["pending", "ready"] } },
    data: { status: "cancelled", draftSource: null, draftCode: null },
  });
}
