import type { JobPublisher } from "@rakazo/adapter-kit";
import {
  pageRevisionAuthorized,
  pageRevisionJob,
  pageRevisionRequestSelect,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { IsolationError, signalPage } from "@rakazo/db";
import { readPageReview, StalePageReviewError, writePageReview } from "./page-collaboration.js";

type Input = { pageId: string; commentId: string };
type Services = { prisma: PrismaClient; events: ThreadEvents };

const MAX_REQUESTS_PER_DAY = 10;

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
  { pageId, commentId }: Input,
) {
  const id = await writePageReview(prisma, actor, pageId, async (tx, { page, owner, grant }) => {
    const comment = await tx.pageComment.findFirst({
      where: { id: commentId, pageId, ...(owner ? {} : { authorId: actor.userId }) },
      select: { version: true, resolvedAt: true, request: { select: { id: true } } },
    });
    if (!comment || comment.version < (grant?.firstVersion ?? 1)) throw new IsolationError();
    if (comment.request) return null;
    if (page.currentVersion !== comment.version) throw new StalePageReviewError();
    if (comment.resolvedAt) throw new ClientError("CONFLICT", "Reopen this comment first");
    const active = await tx.pageRevisionRequest.findFirst({
      where: {
        comment: { pageId, version: comment.version, resolvedAt: null },
        status: { in: ["pending", "ready"] },
        OR: [
          { grantId: null },
          {
            grantId: {
              in: (
                await tx.pageGrant.findMany({
                  where: { pageId, user: { emailVerified: true, deactivatedAt: null } },
                  select: { id: true },
                })
              ).map(({ id }) => id),
            },
          },
        ],
      },
      select: { id: true },
    });
    if (active)
      throw new ClientError("CONFLICT", "This revision already has a bot request in progress");
    const count = await tx.pageRevisionRequest.count({
      where: { comment: { pageId }, createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    });
    if (count >= MAX_REQUESTS_PER_DAY)
      throw new ClientError("TOO_MANY_REQUESTS", "This page has reached its daily revision limit");
    const request = await tx.pageRevisionRequest.create({
      data: { commentId, requesterId: actor.userId, grantId: grant?.id },
      select: pageRevisionRequestSelect,
    });
    if (!(await pageRevisionAuthorized(tx, request))) throw new IsolationError();
    await jobs.enqueueIn(tx, pageRevisionJob(request.id, true));
    return request.id;
  });
  if (id) start(id);
  await signalPage(prisma, events, pageId);
  return { ok: true as const };
}

async function loadDraft(tx: Prisma.TransactionClient, { pageId, commentId }: Input) {
  const request = await tx.pageRevisionRequest.findFirst({
    where: { commentId, comment: { pageId } },
    select: {
      ...pageRevisionRequestSelect,
      draftCode: true,
      draftSource: true,
      resultVersion: true,
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

export function getPageDraft(prisma: PrismaClient, actor: Actor, input: Input) {
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

export async function publishPageDraft({ prisma, events }: Services, actor: Actor, input: Input) {
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
        where: { id: input.commentId },
        data: { resolvedAt: new Date() },
      });
      return version;
    },
    true,
  );
  await signalPage(prisma, events, input.pageId);
  return { version };
}
