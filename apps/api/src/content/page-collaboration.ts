import { createHash } from "node:crypto";
import type { Actor, PageComment, PageReview } from "@rakazo/contracts";
import { PageRevisionStatus } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  cancelPageGrantRequests,
  canPageRequestRevision,
  IsolationError,
  lockPage,
  pageOwnerWhere,
  pageRevisionBotSelect,
  pageRevisionPendingCutoff,
  runAsSystem,
  signalPage,
  signalPageUsers,
  verifiedPageAccount,
} from "@rakazo/db";

const LIST_SIZE = 40;
const MAX_GRANTS = 50;
const MAX_REVIEWER_COMMENTS_PER_HOUR = 30;

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

async function reviewAccess(db: Db, actor: Actor, pageId: string, ownerOnly = false) {
  const { userId, spaceId } = actor;
  const owner = pageOwnerWhere(actor);
  const page = await db.page.findFirst({
    where: { id: pageId, OR: ownerOnly ? [owner] : [owner, reviewWhere(userId)] },
    select: {
      id: true,
      userId: true,
      spaceId: true,
      ...pageRevisionBotSelect,
      title: true,
      visibility: true,
      currentVersion: true,
      grants: {
        where: grantWhere(userId),
        orderBy: [{ firstVersion: "asc" }, { id: "asc" }],
        take: 1,
        select: { id: true, firstVersion: true },
      },
    },
  });
  if (!page) throw new IsolationError();
  const isOwner = page.userId === userId && page.spaceId === spaceId;
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
    prisma.$transaction(async (tx) => work(tx, await reviewAccess(tx, actor, pageId, ownerOnly)), {
      isolationLevel: "RepeatableRead",
    }),
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
      await reviewAccess(tx, actor, pageId, ownerOnly);
      await lockPage(tx, pageId);
      return work(tx, await reviewAccess(tx, actor, pageId, ownerOnly));
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
      canRequestRevision: await canPageRequestRevision(tx, page),
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
        select: { id: true, recipientEmail: true },
        orderBy: { recipientEmail: "asc" },
      });
      return grants.map(({ id, recipientEmail }) => ({ id, email: recipientEmail }));
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
      const recipientEmail = email.toLowerCase();
      const where = { pageId_recipientEmail: { pageId, recipientEmail } };
      const existing = await tx.pageGrant.findUnique({ where });
      if (!existing && (await tx.pageGrant.count({ where: { pageId } })) >= MAX_GRANTS)
        throw new ClientError("CONFLICT", "This page has reached its sharing limit");
      // The owner sees only the address they entered, even when it cannot be bound to a reviewer.
      const users = await tx.user.findMany({
        where: { ...verifiedPageAccount, email: { equals: recipientEmail, mode: "insensitive" } },
        select: { id: true },
        take: 2,
      });

      const recipient = users[0];
      const bound = existing?.bound && existing.userId ? existing : undefined;
      const userId = bound
        ? bound.userId
        : users.length === 1 && recipient && recipient.id !== actor.userId
          ? recipient.id
          : null;
      const binding = {
        userId,
        bound: Boolean(existing?.bound || userId),
        firstVersion: bound?.firstVersion ?? page.currentVersion,
      };
      // An explicit add can bind a replacement account, but the old account's drafts stay revoked.
      if (existing?.bound && !bound && userId) await cancelPageGrantRequests(tx, [existing.id]);
      const row = await tx.pageGrant.upsert({
        where,
        create: { pageId, recipientEmail, ...binding },
        update: binding,
        select: { id: true },
      });
      return { id: row.id, email: recipientEmail, userId };
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
        sectionOccurrence: true,
        body: true,
        createdAt: true,
        resolvedAt: true,
        author: { select: { name: true } },
        requests: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, resultVersion: true, grantId: true, createdAt: true },
        },
      },
    });
    const requestGrants = rows.flatMap(({ requests: [request] }) =>
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
    const pendingCutoff = pageRevisionPendingCutoff();
    return {
      items: rows.slice(0, LIST_SIZE).map(({ requests: [request], ...row }) => ({
        id: row.id,
        author: row.author?.name ?? null,
        mine: row.authorId === actor.userId,
        version: row.version,
        section: row.section,
        sectionOccurrence: row.sectionOccurrence ?? undefined,
        body: row.body,
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        revision: request
          ? {
              id: request.id,
              status:
                request.grantId &&
                !active.has(request.grantId) &&
                (request.status === "pending" || request.status === "ready")
                  ? "cancelled"
                  : request.status === "pending" && request.createdAt < pendingCutoff
                    ? "failed"
                    : PageRevisionStatus.parse(request.status),
              resultVersion: request.resultVersion,
            }
          : null,
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
    sectionOccurrence,
    body,
  }: {
    pageId: string;
    submissionId: string;
    version: number;
    section: string;
    sectionOccurrence?: number;
    body: string;
  },
) {
  const id = createHash("sha256")
    .update(JSON.stringify([pageId, actor.userId, submissionId]))
    .digest("hex");
  const added = await writePageReview(prisma, actor, pageId, async (tx, { page, owner }) => {
    const existing = await tx.pageComment.findUnique({
      where: { id },
      select: { version: true, section: true, sectionOccurrence: true, body: true },
    });
    if (existing) {
      if (
        existing.version === version &&
        existing.section === section &&
        existing.sectionOccurrence === (sectionOccurrence ?? null) &&
        existing.body === body
      )
        return false;
      throw new ClientError("CONFLICT", "This review comment was already posted");
    }
    if (version !== page.currentVersion) throw new StalePageReviewError();
    if (!owner) {
      const recent = await tx.pageComment.count({
        where: {
          pageId,
          authorId: actor.userId,
          createdAt: { gte: new Date(Date.now() - 3_600_000) },
        },
      });
      if (recent >= MAX_REVIEWER_COMMENTS_PER_HOUR)
        throw new ClientError(
          "TOO_MANY_REQUESTS",
          "You've posted too many comments on this page. Try again later.",
        );
    }
    await tx.pageComment.create({
      data: { id, pageId, authorId: actor.userId, version, section, sectionOccurrence, body },
    });
    return true;
  });
  if (added) await signalPage(prisma, events, pageId);
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
