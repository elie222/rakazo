import { createHash } from "node:crypto";
import type { Actor, PageComment, PageReview } from "@rakazo/contracts";
import { PageRevisionStatus } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  cancelPageGrantRequests,
  IsolationError,
  lockPage,
  pageOwnerWhere,
  runAsSystem,
  signalPage,
  signalPageUsers,
  verifiedPageAccount,
} from "@rakazo/db";

const LIST_SIZE = 40;
const MAX_GRANTS = 50;

type Db = Prisma.TransactionClient;
type Dependencies = { prisma: PrismaClient; events: ThreadEvents };

const grantWhere = (userId: string): Prisma.PageGrantWhereInput => ({
  userId,
  user: verifiedPageAccount,
});

const reviewWhere = (userId: string): Prisma.PageWhereInput => ({
  visibility: "people",
  grants: { some: grantWhere(userId) },
});

export async function reviewAccess(db: Db, userId: string, pageId: string, ownerOnly = false) {
  const owner = pageOwnerWhere(userId);
  const page = await db.page.findFirst({
    where: { id: pageId, OR: ownerOnly ? [owner] : [owner, reviewWhere(userId)] },
    select: {
      id: true,
      userId: true,
      spaceId: true,
      botId: true,
      title: true,
      visibility: true,
      currentVersion: true,
      grants: { where: grantWhere(userId), select: { id: true, firstVersion: true } },
    },
  });
  if (!page) throw new IsolationError();
  const isOwner = page.userId === userId;
  const grant = page.grants[0];
  if (!isOwner && (page.visibility !== "people" || !grant)) throw new IsolationError();
  return { page, owner: isOwner, grant: isOwner ? undefined : grant };
}
type Access = Awaited<ReturnType<typeof reviewAccess>>;

export function readPageReview<T>(
  prisma: PrismaClient,
  actor: Actor,
  pageId: string,
  work: (tx: Db, access: Access) => Promise<T>,
  ownerOnly = false,
) {
  return runAsSystem("authorized page review read", () =>
    prisma.$transaction(
      async (tx) => work(tx, await reviewAccess(tx, actor.userId, pageId, ownerOnly)),
      { isolationLevel: "RepeatableRead" },
    ),
  );
}

export function writePageReview<T>(
  prisma: PrismaClient,
  actor: Actor,
  pageId: string,
  work: (tx: Db, access: Access) => Promise<T>,
  ownerOnly = false,
) {
  return runAsSystem("authorized page review write", () =>
    prisma.$transaction(async (tx) => {
      await reviewAccess(tx, actor.userId, pageId, ownerOnly);
      await lockPage(tx, pageId);
      return work(tx, await reviewAccess(tx, actor.userId, pageId, ownerOnly));
    }),
  );
}

export function listPageReviews(prisma: PrismaClient, actor: Actor, cursor?: string) {
  return runAsSystem("list pages granted to this account", async () => {
    const rows = await prisma.page.findMany({
      where: { ...reviewWhere(actor.userId), ...(cursor ? { id: { lt: cursor } } : {}) },
      select: { id: true, title: true },
      orderBy: { id: "desc" },
      take: LIST_SIZE + 1,
    });
    return {
      items: rows.slice(0, LIST_SIZE),
      nextCursor: rows.length > LIST_SIZE ? rows[LIST_SIZE - 1]!.id : null,
    };
  });
}

export function getPageReview(
  prisma: PrismaClient,
  actor: Actor,
  { pageId, version }: { pageId: string; version?: number },
): Promise<PageReview> {
  return readPageReview(prisma, actor, pageId, async (tx, access) => {
    const { page, owner, grant } = access;
    const reviewed = version ?? page.currentVersion;
    if (reviewed < (grant?.firstVersion ?? 1)) throw new IsolationError();
    const stored = await tx.pageVersion.findUnique({
      where: { pageId_version: { pageId, version: reviewed } },
      select: { title: true, code: true },
    });
    if (!stored) throw new IsolationError();
    return {
      id: pageId,
      title: reviewed === page.currentVersion ? page.title : stored.title,
      code: stored.code,
      currentVersion: page.currentVersion,
      version: reviewed,
      owner,
      canRequestRevision: page.botId !== null,
    };
  });
}

export function getPageGrants(prisma: PrismaClient, actor: Actor, pageId: string) {
  return readPageReview(
    prisma,
    actor,
    pageId,
    async (tx, { page }) => {
      if (page.visibility !== "people") return [];
      const grants = await tx.pageGrant.findMany({
        where: { pageId },
        select: { id: true, user: { select: { name: true, email: true } } },
        orderBy: { user: { email: "asc" } },
      });
      return grants.map(({ id, user }) => ({ id, ...user }));
    },
    true,
  );
}

export async function grantPage(
  { prisma, events }: Dependencies,
  actor: Actor,
  { pageId, email }: { pageId: string; email: string },
) {
  const { userId, ...grant } = await writePageReview(
    prisma,
    actor,
    pageId,
    async (tx, { page }) => {
      if (page.visibility !== "people")
        throw new ClientError("CONFLICT", "Choose Specific people before adding someone");
      const users = await tx.user.findMany({
        where: { ...verifiedPageAccount, email: { equals: email, mode: "insensitive" } },
        select: { id: true, email: true, name: true },
        take: 2,
      });
      const user = users[0];
      if (!user || users.length !== 1 || user.id === actor.userId)
        throw new ClientError("NOT_FOUND", "No eligible account uses that email");
      const where = { pageId_userId: { pageId, userId: user.id } };
      const existing = await tx.pageGrant.findUnique({ where, select: { id: true } });
      if (!existing && (await tx.pageGrant.count({ where: { pageId } })) >= MAX_GRANTS)
        throw new ClientError("CONFLICT", "This page has reached its sharing limit");
      const row =
        existing ??
        (await tx.pageGrant.create({
          data: { pageId, userId: user.id, firstVersion: page.currentVersion },
          select: { id: true },
        }));
      return { id: row.id, name: user.name, email: user.email, userId: user.id };
    },
    true,
  );
  await signalPageUsers(events, [actor.userId, userId]);
  return grant;
}

export async function revokePage(
  { prisma, events }: Dependencies,
  actor: Actor,
  { pageId, grantId }: { pageId: string; grantId: string },
) {
  const removed = await writePageReview(
    prisma,
    actor,
    pageId,
    async (tx) => {
      const grant = await tx.pageGrant.findFirst({ where: { id: grantId, pageId } });
      if (grant) {
        await cancelPageGrantRequests(tx, [grant.id]);
        await tx.pageGrant.delete({ where: { id: grant.id } });
      }
      return grant;
    },
    true,
  );
  await signalPageUsers(events, [actor.userId, ...(removed ? [removed.userId] : [])]);
  return { ok: true as const };
}

export function pageComments(
  prisma: PrismaClient,
  actor: Actor,
  { pageId, cursor }: { pageId: string; cursor?: string },
): Promise<{ items: PageComment[]; nextCursor: string | null }> {
  return readPageReview(prisma, actor, pageId, async (tx, { grant }) => {
    const where = { pageId, version: { gte: grant?.firstVersion ?? 1 } };
    const after = cursor
      ? await tx.pageComment.findFirst({
          where: { ...where, id: cursor },
          select: { id: true, createdAt: true },
        })
      : null;
    if (cursor && !after) throw new IsolationError();
    const rows = await tx.pageComment.findMany({
      where: {
        ...where,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: LIST_SIZE + 1,
      select: {
        id: true,
        authorId: true,
        version: true,
        section: true,
        body: true,
        createdAt: true,
        resolvedAt: true,
        author: { select: { name: true } },
        request: { select: { status: true, resultVersion: true, grantId: true } },
      },
    });
    const requestGrants = rows.flatMap(({ request }) =>
      request?.grantId ? [request.grantId] : [],
    );
    const active = new Set(
      (
        await tx.pageGrant.findMany({
          where: { pageId, id: { in: requestGrants }, user: verifiedPageAccount },
          select: { id: true },
        })
      ).map(({ id }) => id),
    );
    return {
      items: rows.slice(0, LIST_SIZE).map((row) => ({
        id: row.id,
        author: row.author?.name ?? null,
        mine: row.authorId === actor.userId,
        version: row.version,
        section: row.section,
        body: row.body,
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        revision: row.request && {
          status:
            row.request.grantId &&
            !active.has(row.request.grantId) &&
            (row.request.status === "pending" || row.request.status === "ready")
              ? "cancelled"
              : PageRevisionStatus.parse(row.request.status),
          resultVersion: row.request.resultVersion,
        },
      })),
      nextCursor: rows.length > LIST_SIZE ? rows[LIST_SIZE - 1]!.id : null,
    };
  });
}

export class StalePageReviewError extends ClientError {
  constructor() {
    super("CONFLICT", "The page has a newer revision");
  }
}

export async function addPageComment(
  { prisma, events }: Dependencies,
  actor: Actor,
  {
    pageId,
    submissionId,
    version,
    section,
    body,
  }: {
    pageId: string;
    submissionId: string;
    version: number;
    section: string;
    body: string;
  },
) {
  const id = createHash("sha256")
    .update(JSON.stringify([pageId, actor.userId, submissionId]))
    .digest("hex");
  await writePageReview(prisma, actor, pageId, async (tx, { page }) => {
    const existing = await tx.pageComment.findUnique({
      where: { id },
      select: { version: true, section: true, body: true },
    });
    if (existing) {
      if (existing.version === version && existing.section === section && existing.body === body)
        return;
      throw new ClientError("CONFLICT", "This review comment was already posted");
    }
    if (version !== page.currentVersion) throw new StalePageReviewError();
    await tx.pageComment.create({
      data: { id, pageId, authorId: actor.userId, version, section, body },
    });
  });
  await signalPage(prisma, events, pageId);
  return { id };
}

export async function resolvePageComment(
  { prisma, events }: Dependencies,
  actor: Actor,
  { pageId, commentId, resolved }: { pageId: string; commentId: string; resolved: boolean },
) {
  await writePageReview(prisma, actor, pageId, async (tx, { owner, grant }) => {
    const where = {
      id: commentId,
      pageId,
      version: { gte: grant?.firstVersion ?? 1 },
      ...(owner ? {} : { authorId: actor.userId }),
    };
    const row = await tx.pageComment.findFirst({ where, select: { resolvedAt: true } });
    if (!row) throw new IsolationError();
    if (Boolean(row.resolvedAt) === resolved) return;
    await tx.pageComment.update({
      where: { id: commentId },
      data: { resolvedAt: resolved ? new Date() : null },
    });
    if (resolved) {
      await tx.pageRevisionRequest.updateMany({
        where: { commentId, status: { in: ["pending", "ready"] } },
        data: { status: "cancelled", draftCode: null, draftSource: null },
      });
    }
  });
  await signalPage(prisma, events, pageId);
  return { ok: true as const };
}
