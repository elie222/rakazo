import { bestEffort } from "@rakazo/logging";
import type { PrismaClient } from "../database/client.js";
import { retryWhileDatabaseUnavailable } from "../database/database-outage.js";
import { runAsSystem } from "../database/row-security.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ThreadEvents } from "../threads/events.js";

export const pageChangesScope = (userId: string) => `pages:${userId}`;

export function signalPageUsers(events: ThreadEvents, userIds: readonly (string | null)[]) {
  return Promise.all(
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
