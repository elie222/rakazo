import type { JobPublisher } from "@rakazo/adapter-kit";
import {
  pageRevisionAuthorized,
  pageRevisionJob,
  pageRevisionRequestSelect,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  canPageRequestRevision,
  IsolationError,
  pageRevisionPendingCutoff,
  signalPage,
  verifiedPageAccount,
} from "@rakazo/db";
import type { RouterDeps } from "../router.js";
import { readPageReview, StalePageReviewError, writePageReview } from "./page-collaboration.js";

type DraftInput = { pageId: string; requestId: string };
type Services = { prisma: PrismaClient; events: ThreadEvents };

const MAX_OWNER_REQUESTS_PER_DAY = 10;
const MAX_SHARED_REQUESTS_PER_DAY = 5;
const MAX_REQUESTS_PER_REVIEWER_PER_DAY = 3;
const DAY_MS = 86_400_000;

export async function getPageRevisionRecipient(deps: RouterDeps, actor: Actor, pageId: string) {
  if (!deps.pageRevisions)
    throw new ClientError("SERVICE_UNAVAILABLE", "Page revisions are unavailable");
  const scope = await readPageReview(deps.prisma, actor, pageId, async (tx, { page }) => {
    if (!page.bot || !(await canPageRequestRevision(tx, page))) throw new IsolationError();
    return { spaceId: page.spaceId, userId: page.userId, botId: page.bot.id };
  });
  return deps.pageRevisions.recipient(pageId, scope);
}

export async function askPageRevision(
  {
    prisma,
    events,
    jobs,
    start,
  }: Services & {
    jobs: JobPublisher;
    start: (id: string) => void;
  },
  actor: Actor,
  { pageId, commentId, retryOf }: { pageId: string; commentId: string; retryOf?: string },
) {
  const id = await writePageReview(prisma, actor, pageId, async (tx, { page, owner, grant }) => {
    const pendingCutoff = pageRevisionPendingCutoff();
    const comment = await tx.pageComment.findFirst({
      where: { id: commentId, pageId, ...(owner ? {} : { authorId: actor.userId }) },
      select: {
        version: true,
        resolvedAt: true,
        requests: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: pageRevisionRequestSelect,
        },
      },
    });
    if (!comment || comment.version < (grant?.firstVersion ?? 1)) throw new IsolationError();
    const previous = comment.requests[0];
    if (previous && !retryOf) return null;
    if (retryOf && retryOf !== previous?.id) {
      const replay = await tx.pageRevisionRequest.findFirst({
        where: { commentId, retryOf },
        select: { id: true },
      });
      if (replay) return null;
      throw new ClientError("CONFLICT", "The bot request changed");
    }
    if (page.currentVersion !== comment.version) throw new StalePageReviewError();
    if (comment.resolvedAt) throw new ClientError("CONFLICT", "Reopen this comment first");
    if (previous?.status === "published") return null;
    if (previous && (previous.status === "pending" || previous.status === "ready")) {
      const expired = previous.status === "pending" && previous.createdAt < pendingCutoff;
      if (!expired && (await pageRevisionAuthorized(tx, previous))) return null;
      await tx.pageRevisionRequest.update({
        where: { id: previous.id },
        data: { status: expired ? "failed" : "cancelled", draftCode: null, draftSource: null },
      });
    }
    const active = await tx.pageRevisionRequest.findFirst({
      where: {
        comment: { pageId, version: comment.version, resolvedAt: null },
        OR: [{ status: "pending", createdAt: { gte: pendingCutoff } }, { status: "ready" }],
        AND: {
          OR: [
            { grantId: null },
            {
              grantId: {
                in: (
                  await tx.pageGrant.findMany({
                    where: { pageId, user: verifiedPageAccount },
                    select: { id: true },
                  })
                ).map(({ id }) => id),
              },
            },
          ],
        },
      },
      select: { id: true },
    });
    if (active)
      throw new ClientError("CONFLICT", "This revision already has a bot request in progress");
    const recent = { comment: { pageId }, createdAt: { gte: new Date(Date.now() - DAY_MS) } };
    const count = await tx.pageRevisionRequest.count({
      where: { ...recent, requesterId: owner ? page.userId : { not: page.userId } },
    });
    if (count >= (owner ? MAX_OWNER_REQUESTS_PER_DAY : MAX_SHARED_REQUESTS_PER_DAY))
      throw new ClientError("TOO_MANY_REQUESTS", "The daily revision limit has been reached");
    if (!owner) {
      const requested = await tx.pageRevisionRequest.count({
        where: { ...recent, requesterId: actor.userId },
      });
      if (requested >= MAX_REQUESTS_PER_REVIEWER_PER_DAY)
        throw new ClientError(
          "TOO_MANY_REQUESTS",
          "You've reached your daily revision limit for this page",
        );
    }
    const request = await tx.pageRevisionRequest.create({
      data: {
        commentId,
        retryOf,
        requesterId: actor.userId,
        consentSpaceId: actor.spaceId,
        grantId: grant?.id,
        // Writes are serialized per page. Distinguish the latest even when two writes share a millisecond.
        createdAt: new Date(Math.max(Date.now(), (previous?.createdAt.getTime() ?? 0) + 1)),
      },
      select: pageRevisionRequestSelect,
    });
    if (!(await pageRevisionAuthorized(tx, request))) throw new IsolationError();
    await jobs.enqueueIn(tx, pageRevisionJob(request.id, true));
    return request.id;
  });
  if (id) {
    start(id);
    await signalPage(prisma, events, pageId);
  }
  return { ok: true as const };
}

async function loadDraft(tx: Prisma.TransactionClient, { pageId, requestId }: DraftInput) {
  const request = await tx.pageRevisionRequest.findFirst({
    where: { id: requestId, comment: { pageId } },
    select: {
      ...pageRevisionRequestSelect,
      draftCode: true,
      draftSource: true,
      resultVersion: true,
      commentId: true,
    },
  });
  if (!request) throw new IsolationError();
  return request;
}

async function requireReadyDraft(
  tx: Prisma.TransactionClient,
  request: Awaited<ReturnType<typeof loadDraft>>,
) {
  if (request.comment.page.currentVersion !== request.comment.version)
    throw new StalePageReviewError();
  if (!(await pageRevisionAuthorized(tx, request))) throw new IsolationError();
  if (request.status !== "ready" || !request.draftCode || !request.draftSource)
    throw new ClientError("CONFLICT", "The bot draft isn't ready");
  return { code: request.draftCode, source: request.draftSource };
}

export function getPageDraft(prisma: PrismaClient, actor: Actor, input: DraftInput) {
  return readPageReview(
    prisma,
    actor,
    input.pageId,
    async (tx) => {
      const draft = await requireReadyDraft(tx, await loadDraft(tx, input));
      return { code: draft.code };
    },
    true,
  );
}

export async function publishPageDraft(
  { prisma, events }: Services,
  actor: Actor,
  input: DraftInput,
) {
  const version = await writePageReview(
    prisma,
    actor,
    input.pageId,
    async (tx, { page }) => {
      const request = await loadDraft(tx, input);
      if (request.status === "published" && request.resultVersion) return request.resultVersion;
      const draft = await requireReadyDraft(tx, request);
      const version = page.currentVersion + 1;
      await tx.pageVersion.create({
        data: { ...draft, pageId: page.id, version, title: page.title },
      });
      await tx.page.update({
        where: { id: page.id },
        data: { currentVersion: version, updatedAt: new Date() },
      });
      await tx.pageRevisionRequest.update({
        where: { id: request.id },
        data: { status: "published", resultVersion: version, draftCode: null, draftSource: null },
      });
      await tx.pageComment.update({
        where: { id: request.commentId },
        data: { resolvedAt: new Date() },
      });
      return version;
    },
    true,
  );
  await signalPage(prisma, events, input.pageId);
  return { version };
}
