import { createHash, randomUUID } from "node:crypto";
import type {
  AgentRunRequest,
  AgentRuntime,
  BackgroundJob,
  BackgroundJobAttempt,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import { containsSecret, deadlineSignal, withAbort } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  assertLeaseHeld,
  canPageRequestRevision,
  lockPage,
  memberHasModelAccess,
  pageRevisionBotSelect,
  recordUsage,
  runAsSystem,
  runAsTenant,
  signalPage,
  verifiedPageAccount,
  withLease,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { checkPageSource } from "@rakazo/page-kit/validate";
import { aiRecipient } from "../models/ai-consent.js";
import { PAGE_REVISION_INSTRUCTIONS, pageRevisionPrompt } from "./page-revision.prompt.js";

const MODEL_TIMEOUT = 90_000;
const BACKUP_DELAY = MODEL_TIMEOUT + 15_000;
const MAX_ATTEMPTS = 3;

export function pageRevisionJob(requestId: string, backup = false): BackgroundJob {
  return {
    name: "page.revise",
    payload: { requestId },
    replaceKey: revisionKey(requestId),
    availableAt: backup ? new Date(Date.now() + BACKUP_DELAY) : undefined,
    maxAttempts: MAX_ATTEMPTS,
  };
}

const revisionKey = (id: string) => `page-revision:${id}`;

const requestSelect = {
  id: true,
  requesterId: true,
  consentSpaceId: true,
  grantId: true,
  status: true,
  comment: {
    select: {
      version: true,
      section: true,
      body: true,
      resolvedAt: true,
      page: {
        select: {
          id: true,
          userId: true,
          spaceId: true,
          currentVersion: true,
          visibility: true,
          ...pageRevisionBotSelect,
        },
      },
    },
  },
} satisfies Prisma.PageRevisionRequestSelect;

type Request = Prisma.PageRevisionRequestGetPayload<{ select: typeof requestSelect }>;

function pageRevisionRecipient(pageId: string, model: AgentRunRequest["model"]) {
  const recipient = aiRecipient({
    provider: model.provider,
    modelId: model.id,
    baseUrl: model.baseUrl,
    use: "model",
    hideEndpoint: true,
  });
  if (!recipient) return null;
  const key = createHash("sha256")
    .update(JSON.stringify(["page-revision", pageId, recipient.key]))
    .digest("hex");
  return { ...recipient, key };
}

export async function pageRevisionAuthorized(tx: Prisma.TransactionClient, row: Request) {
  const { comment, requesterId, grantId } = row;
  const { page } = comment;
  if (comment.resolvedAt || page.currentVersion !== comment.version) return false;
  if (!(await canPageRequestRevision(tx, page))) return false;
  if (!grantId) return requesterId === page.userId;
  if (page.visibility !== "people") return false;
  return Boolean(
    await tx.pageGrant.findFirst({
      where: {
        id: grantId,
        pageId: page.id,
        userId: requesterId,
        user: verifiedPageAccount,
        firstVersion: { lte: comment.version },
      },
      select: { id: true },
    }),
  );
}

export const pageRevisionRequestSelect = requestSelect;

type Dependencies = {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: ThreadEvents;
  runtime: AgentRuntime;
  resolveModel: (scope: {
    spaceId: string;
    userId: string;
    botId: string;
  }) => Promise<AgentRunRequest["model"]>;
  billingEnabled?: boolean;
};

export function createPageRevisions(deps: Dependencies) {
  const { prisma, jobs, events } = deps;

  async function work(requestId: string, attempt?: BackgroundJobAttempt) {
    const key = revisionKey(requestId);
    return runAsSystem("process a page-only revision request", () =>
      withLease(
        prisma,
        key,
        { ttlMs: 30_000, signal: deadlineSignal(BACKUP_DELAY - 5_000) },
        async (lease) => {
          const read = () =>
            prisma.pageRevisionRequest.findUnique({
              where: { id: requestId },
              select: requestSelect,
            });
          const row = await read();
          if (row?.status !== "pending") return;
          const { comment } = row;
          const { page } = comment;
          let draft: { draftSource: string; draftCode: string } | undefined;
          if (await pageRevisionAuthorized(prisma, row)) {
            const source = await prisma.pageVersion.findUnique({
              where: { pageId_version: { pageId: page.id, version: comment.version } },
              select: { source: true },
            });
            if (source && page.bot) {
              const scope = { spaceId: page.spaceId, userId: page.userId, botId: page.bot.id };
              try {
                draft = await runAsTenant(scope, () =>
                  generateDraft(
                    deps,
                    scope,
                    requestId,
                    source.source,
                    comment,
                    lease.signal,
                    (model) =>
                      runAsSystem(
                        "recheck page access and AI consent before model dispatch",
                        async () => {
                          const fresh = await read();
                          if (
                            fresh?.status !== "pending" ||
                            !(await pageRevisionAuthorized(prisma, fresh))
                          )
                            return false;
                          const recipient = pageRevisionRecipient(page.id, model);
                          if (!recipient) return true;
                          if (!fresh.consentSpaceId) return false;
                          return Boolean(
                            await prisma.aiDataConsent.findFirst({
                              where: {
                                userId: fresh.requesterId,
                                spaceId: fresh.consentSpaceId,
                                recipientKey: recipient.key,
                                version: AI_DISCLOSURE_VERSION,
                              },
                              select: { recipientKey: true },
                            }),
                          );
                        },
                      ),
                  ),
                );
              } catch (error) {
                if (!attempt || attempt.number < attempt.max) throw error;
                getLogger().error("page revision failed after retries", error, {
                  "page.revision_request_id": requestId,
                });
              }
            }
          }
          await prisma.$transaction(async (tx) => {
            await lockPage(tx, page.id);
            await assertLeaseHeld(tx, lease);
            const fresh = await tx.pageRevisionRequest.findUnique({
              where: { id: requestId },
              select: requestSelect,
            });
            if (fresh?.status !== "pending") return;
            const authorized = await pageRevisionAuthorized(tx, fresh);
            await tx.pageRevisionRequest.update({
              where: { id: requestId },
              data:
                authorized && draft
                  ? { ...draft, status: "ready" }
                  : {
                      status: authorized ? "failed" : "cancelled",
                    },
            });
          });
          await bestEffort("signal page revision", signalPage(prisma, events, page.id));
        },
      ),
    );
  }

  return {
    work,
    async recipient(pageId: string, scope: Parameters<Dependencies["resolveModel"]>[0]) {
      return runAsTenant(scope, async () =>
        pageRevisionRecipient(pageId, await deps.resolveModel(scope)),
      );
    },
    start(requestId: string) {
      // The committed Graphile job covers a crash. The caller's process starts the model now.
      void bestEffort(
        "start page revision",
        (async () => {
          try {
            await work(requestId);
          } catch (error) {
            await jobs.enqueue(pageRevisionJob(requestId));
            throw error;
          }
          await jobs.cancel(revisionKey(requestId));
        })(),
      );
    },
  };
}

async function generateDraft(
  deps: Dependencies,
  scope: { spaceId: string; userId: string; botId: string },
  requestId: string,
  source: string,
  comment: { section: string; body: string },
  parentSignal: AbortSignal,
  authorized: (model: AgentRunRequest["model"]) => Promise<boolean>,
) {
  const signal = deadlineSignal(MODEL_TIMEOUT, parentSignal);
  if (deps.billingEnabled && !(await memberHasModelAccess(deps.prisma, scope))) return;
  const model = await withAbort(deps.resolveModel(scope), signal);
  if (!(await authorized(model))) return;
  signal.throwIfAborted();
  const id = `${revisionKey(requestId)}:${randomUUID()}`;
  const onUsage: NonNullable<AgentRunRequest["onUsage"]> = async (event) => {
    await recordUsage(deps.prisma, event, { ...scope, operationId: id, operationKind: "answer" });
  };
  let text: string | undefined;
  for await (const event of deps.runtime.run(
    {
      botId: scope.botId,
      threadId: id,
      runId: id,
      model,
      instructions: PAGE_REVISION_INSTRUCTIONS,
      prompt: pageRevisionPrompt(source, comment.section, comment.body),
      history: [],
      tools: [],
      allowSilentEmpty: true,
      onUsage,
      usageOperationKind: "answer",
    },
    { ...scope, signal, operationId: id, traceId: id },
  )) {
    if (event.type === "usage" && !event.accounted) await onUsage(event);
    if (event.type === "done") text = event.text?.trim();
  }
  signal.throwIfAborted();
  if (!text) return;
  const draftSource = /^```(?:tsx|jsx)?\s+([\s\S]*?)\s+```$/.exec(text)?.[1] ?? text;
  if (draftSource === source) return;
  const checked = checkPageSource(draftSource);
  if (
    !checked.ok ||
    containsSecret(
      [draftSource, checked.code],
      [model.apiKey ?? "", ...Object.values(model.headers ?? {})].filter(Boolean),
    )
  )
    return;
  return { draftSource, draftCode: checked.code };
}
