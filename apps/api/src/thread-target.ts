import { ORPCError } from "@orpc/server";
import type { JobPublisher, ProductAnalytics, SandboxProvider } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { cancelComputerRunWork, screenLeaseIdForRun, toComputerRef } from "@rakazo/adapters";
import type {
  Actor,
  GroupMember,
  MessageBlock,
  MessageReaction,
  ReplyPreview,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  GROUP_MEMBER_MIN,
  MessageBlock as MessageBlockSchema,
  resolveBotAvatarSet,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_RUN_TRIGGERS,
  callIdFromClientNonce,
  isConversationalRun,
  messageBypassesTakeoverWait,
  messageReaction,
  projectMessages,
  QUEUE_HOLDING_RUN_STATUSES,
  resolveGroupTargetBotIds,
  runFailureError,
  runReadsThreadHistory,
} from "@rakazo/core";
import { deriveMessageQuote, messageReplyPreview } from "@rakazo/core/message-quote";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  answerWaitingRunWithTextInTransaction,
  appendEventInTransaction,
  clearEndedRunState,
  createGroupRepos,
  createRepos,
  createThreadMessageInTransaction,
  eligibleWaitingTextAnswer,
  expireComputerExecutionLeases,
  IsolationError,
  lockOwnedGroup,
  primaryActiveRun,
  retireWaitingQuestionInTransaction,
  touchGroupUpdatedAt,
  transientRunEventsWhere,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  buildSendPrompt,
  buildUserMessageBlocks,
  resolveGroupSendAttachments,
  resolveSendAttachments,
} from "./artifacts.js";
import { resolveBusyBotName, toComputerStatus } from "./computer-status.js";
import { withSerializableRetry } from "./serializable-retry.js";
import type { ImageAdmissionRun } from "./thread-image-admission.js";
import { assertThreadImageInput } from "./thread-image-admission.js";
import { loadMessagePage } from "./thread-message-pages.js";

export type ThreadTarget =
  | {
      kind: "bot";
      botId: string;
      threadId: string;
      bot: Awaited<ReturnType<ReturnType<typeof createRepos>["getBot"]>>;
    }
  | {
      kind: "group";
      groupId: string;
      threadId: string;
      groupName: string;
      members: GroupMember[];
      memberBotIds: string[];
    };

const THREAD_MESSAGE_PAGE_SIZE = 100;
const RUNS_NEEDING_CONTINUE = new Set(["queued", "waiting_takeover"]);

const STEERABLE_RUN_STATUSES = new Set<string>(QUEUE_HOLDING_RUN_STATUSES);
/**
 * An answer steers the waiting run it resumes when the model must see its image, or when the run
 * reads no thread history and would otherwise never get the attachment.
 */
function answerSteersRun(
  run: { trigger?: string | null },
  attachments: MessageBlock[],
  imageHandling: "confirm" | "file" | undefined,
) {
  return (
    (imageHandling === "confirm" && attachments.some((block) => block.kind === "image")) ||
    (attachments.length > 0 && !runReadsThreadHistory(run.trigger))
  );
}

/** Background work holds pending steering; paused cards never hold the queue. */
function steersUserMessage(run: { status: string; trigger?: string | null }) {
  return STEERABLE_RUN_STATUSES.has(run.status) && isConversationalRun(run.trigger);
}

type MentionTargetInput = string | { kind: "bot" | "group" | "routine" | "connector"; id: string };

function splitMentionTargets(mentions: MentionTargetInput[] | undefined) {
  const botMentionIds = new Set<string>();
  const groupMentionIds = new Set<string>();
  const routineMentionIds = new Set<string>();
  const connectorMentionIds = new Set<string>();
  for (const mention of mentions ?? []) {
    if (typeof mention === "string") {
      botMentionIds.add(mention);
      continue;
    }
    if (mention.kind === "bot") botMentionIds.add(mention.id);
    if (mention.kind === "group") groupMentionIds.add(mention.id);
    if (mention.kind === "routine") routineMentionIds.add(mention.id);
    if (mention.kind === "connector") connectorMentionIds.add(mention.id);
  }
  return {
    botMentionIds: [...botMentionIds],
    groupMentionIds: [...groupMentionIds],
    routineMentionIds: [...routineMentionIds],
    connectorMentionIds: [...connectorMentionIds],
  };
}

async function resolveOwnedConnectorDisplayNames(
  tx: Prisma.TransactionClient,
  actor: Actor,
  connectionIds: string[],
) {
  if (!connectionIds.length) return [];
  const rows = await tx.connection.findMany({
    where: {
      id: { in: connectionIds },
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: "connected",
    },
    select: { id: true, displayName: true },
  });
  if (rows.length !== connectionIds.length) throw new IsolationError();
  const byId = new Map(rows.map((row) => [row.id, row.displayName]));
  return connectionIds.map((id) => byId.get(id) ?? "connector");
}

function sendRunClientNonce(
  clientNonce: string | undefined,
  messageId: string,
  botId?: string,
): string | undefined {
  if (!clientNonce) return undefined;
  return botId ? `send:${messageId}:${botId}` : `send:${messageId}`;
}

async function enqueueRunsNeedingContinue(
  jobs: JobPublisher,
  runs: Array<{ id: string; status: string }>,
) {
  await Promise.all(
    runs
      .filter((run) => RUNS_NEEDING_CONTINUE.has(run.status))
      .map((run) =>
        jobs.enqueue(runContinueJob(run.id)).catch((error) => {
          // The queued run is durable; the reconciler repairs a missed immediate wake.
          getLogger().error("thread send enqueue", error);
        }),
      ),
  );
}

async function findSendReceipt(prisma: PrismaClient, threadId: string, clientNonce: string) {
  return prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId, clientNonce } },
    include: { sourceRuns: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
}

async function replayExistingSend(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  threadId: string,
  clientNonce: string | undefined,
  releaseTakeover?: (runId: string) => Promise<void>,
) {
  if (!clientNonce) return null;
  const message = await findSendReceipt(deps.prisma, threadId, clientNonce);
  if (!message) return null;
  const receiptEvent = await deps.prisma.event.findFirst({
    where: {
      threadId,
      type: "thread.message.created",
      payload: { path: ["messageId"], equals: message.id },
    },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const receiptRunIds = sendEventRunIds(receiptEvent?.payload);
  const receiptRuns = receiptRunIds.length
    ? await deps.prisma.run.findMany({ where: { id: { in: receiptRunIds } } })
    : [];
  const receiptRunById = new Map(receiptRuns.map((run) => [run.id, run]));
  const orderedReceiptRuns = receiptRunIds.flatMap((id) => {
    const run = receiptRunById.get(id);
    return run ? [run] : [];
  });
  const linkedRun =
    message.sourceRuns[0] ??
    (message.runId ? await deps.prisma.run.findUnique({ where: { id: message.runId } }) : null);
  if (!linkedRun && orderedReceiptRuns.length === 0) return null;
  const runs = orderedReceiptRuns.length
    ? orderedReceiptRuns
    : message.sourceRuns.length
      ? message.sourceRuns
      : [linkedRun!];
  const pendingSteering = releaseTakeover
    ? await deps.prisma.steeringMessage.findFirst({
        where: { messageId: message.id, claimedAt: null },
        select: { runId: true },
      })
    : null;
  if (releaseTakeover && pendingSteering?.runId) await releaseTakeover(pendingSteering.runId);
  await enqueueRunsNeedingContinue(deps.jobs, runs);
  const latestEvent = await deps.prisma.event.findFirst({
    where: { threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  if (latestEvent) {
    await deps.events.notify(threadId, latestEvent.seq).catch((error) => {
      // Subscribers catch up from the durable event cursor after a missed realtime wake.
      getLogger().error("thread send realtime notification", error);
    });
  }
  return sendResult(message, runs);
}

function sendEventRunIds(payload: Prisma.JsonValue | undefined): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const runIds = (payload as { runIds?: unknown }).runIds;
  return Array.isArray(runIds) ? runIds.filter((id): id is string => typeof id === "string") : [];
}

function sendResult(message: { seq: number }, runs: Array<{ id: string; taskId: string }>) {
  const first = runs[0];
  if (!first) throw new IsolationError("Send did not create a run");
  return {
    taskId: first.taskId,
    runId: first.id,
    seq: message.seq,
    runIds: runs.map((run) => run.id),
  };
}

export async function cancelSupersededQueuedRuns(
  tx: Prisma.TransactionClient,
  input: { threadId: string; botIds: string[]; keepRunIds: string[] },
) {
  const superseded = await tx.run.findMany({
    where: {
      threadId: input.threadId,
      botId: { in: input.botIds },
      status: "queued",
      OR: [{ trigger: "user", sourceMessage: { role: "user" } }, { trigger: "reaction" }],
      id: { notIn: input.keepRunIds },
    },
    select: { id: true, taskId: true },
  });
  if (superseded.length === 0) return;
  const now = new Date();
  await tx.run.updateMany({
    where: { id: { in: superseded.map((run) => run.id) } },
    data: { status: "cancelled", completedAt: now },
  });
  await clearEndedRunState(
    tx,
    superseded.map((run) => run.id),
  );
  await tx.task.updateMany({
    where: { id: { in: superseded.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}

async function lockAndLoadGroupMembers(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: Extract<ThreadTarget, { kind: "group" }>,
) {
  await lockOwnedGroup(tx, actor, target.groupId);
  const group = await tx.chatGroup.findFirst({
    where: {
      id: target.groupId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
      thread: { id: target.threadId },
    },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: { bot: { select: { id: true, name: true, color: true, avatarSet: true } } },
        orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
      },
    },
  });
  if (!group || group.members.length < GROUP_MEMBER_MIN) throw new IsolationError();
  return group.members.map((member) => ({
    botId: member.bot.id,
    name: member.bot.name,
    color: member.bot.color,
    avatarSet: resolveBotAvatarSet(member.bot.avatarSet),
  }));
}

/** The bots a send wakes: the bot itself, or the group members it names (else the first). */
export function sendTargetBotIds(
  target:
    | { kind: "bot"; botId: string }
    | { kind: "group"; members: Array<{ botId: string; name: string }> },
  input: { text?: string; mentions?: MentionTargetInput[] },
): string[] {
  if (target.kind === "bot") return [target.botId];
  return resolveGroupTargetBotIds({
    text: input.text ?? "",
    members: target.members.map((member) => ({ id: member.botId, name: member.name })),
    explicitMentions: splitMentionTargets(input.mentions).botMentionIds,
  });
}

export async function resolveThreadTarget(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId?: string; groupId?: string },
  options: { includeArchived?: boolean } = {},
): Promise<ThreadTarget> {
  const repos = createRepos(prisma);
  const groupRepos = createGroupRepos(prisma);
  if (input.botId) {
    const bot = await repos.getBot(actor, input.botId, options);
    if (!bot.thread) throw new IsolationError();
    return {
      kind: "bot",
      botId: bot.id,
      threadId: bot.thread.id,
      bot,
    };
  }
  if (input.groupId) {
    const group = await groupRepos.getGroupTarget(actor, input.groupId);
    if (!group.thread) throw new IsolationError();
    const members = group.members.map((member) => ({
      botId: member.bot.id,
      name: member.bot.name,
      color: member.bot.color,
      avatarSet: resolveBotAvatarSet(member.bot.avatarSet),
      status: primaryActiveRun(member.bot.runs)?.status ?? "idle",
    }));
    return {
      kind: "group",
      groupId: group.id,
      threadId: group.thread.id,
      groupName: group.name,
      members,
      memberBotIds: members.map((member) => member.botId),
    };
  }
  throw new IsolationError();
}

export async function threadHead(prisma: PrismaClient, target: ThreadTarget) {
  const latest = await prisma.event.findFirst({
    where: { threadId: target.threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return { threadId: target.threadId, cursor: latest?.seq ?? -1 };
}

export async function threadSnapshot(
  deps: { prisma: PrismaClient },
  target: ThreadTarget,
): Promise<ThreadSnapshot> {
  // Lock the thread row so messages, the event cursor, active runs, and live
  // progress are read from one consistent commit. A torn Promise.all can
  // otherwise advance the client cursor past thread.message.created while the
  // ask message page still omits it — leaving waiting_input with no AskCard.
  if (target.kind === "bot") {
    const [busyBotName, core] = await Promise.all([
      resolveBusyBotName(deps.prisma, {
        computerId: target.bot.computer?.id,
        botId: target.botId,
        botName: target.bot.name,
      }),
      deps.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR SHARE`;
          const [messagePage, last, activeRuns, busyOrFailed] = await Promise.all([
            loadMessagePage(tx, target.threadId, undefined, THREAD_MESSAGE_PAGE_SIZE),
            tx.event.findFirst({
              where: { threadId: target.threadId },
              orderBy: { seq: "desc" },
              select: { seq: true },
            }),
            tx.run.findMany({
              where: {
                botId: target.botId,
                threadId: target.threadId,
                status: { in: [...ACTIVE_RUN_STATUSES] },
                OR: [
                  { trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] } },
                  { status: { in: ["waiting_input", "waiting_takeover"] } },
                ],
              },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            }),
            tx.run.findFirst({
              where: {
                botId: target.botId,
                threadId: target.threadId,
                // Background ticket work stays silent; waiting is handled above.
                trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
                status: { in: [...ACTIVE_RUN_STATUSES, "failed"] },
              },
              // The id tiebreak keeps ordering deterministic under equal
              // timestamps, matching the supersession probe below.
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            }),
          ]);
          const run = pickPrimaryPrivateActiveRun(activeRuns) ?? busyOrFailed;
          // A failure only surfaces while it is still the newest terminal run, or a stale
          // failure would reappear on every load. Compare by ordering, not timestamps:
          // equal createdAt values reverse under gt/gte.
          const newestTerminal =
            run?.status === "failed"
              ? await tx.run.findFirst({
                  where: {
                    botId: target.botId,
                    threadId: target.threadId,
                    // Background failures must not bury a user-visible failure.
                    trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
                    status: { in: ["failed", "completed", "cancelled"] },
                  },
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                  select: { id: true },
                })
              : null;
          const currentRun = run?.status === "failed" && newestTerminal?.id !== run.id ? null : run;
          const liveRuns = activeRuns.filter((run) => run.trigger !== "bot_message");
          const liveEvents =
            liveRuns.length > 0
              ? await tx.event.findMany({
                  where: {
                    threadId: target.threadId,
                    runId: { in: liveRuns.map((run) => run.id) },
                    type: {
                      in: [
                        "thread.progress",
                        "thread.subagent",
                        "run.waiting_input",
                        "computer.takeover.requested",
                        "agent.tool.called",
                        "agent.tool.completed",
                      ],
                    },
                  },
                  orderBy: { seq: "asc" },
                })
              : [];
          return { messagePage, last, run: currentRun, activeRuns, liveEvents };
        },
        { timeout: 15_000, maxWait: 5_000 },
      ),
    ]);
    return {
      botId: target.botId,
      threadId: target.threadId,
      cursor: core.last?.seq ?? -1,
      messages: messagesWithLiveEvents(core.messagePage.messages, core.liveEvents, core.activeRuns),
      olderCursor: core.messagePage.olderCursor,
      run: core.run ? mapRun(core.run) : null,
      activeRuns: core.activeRuns.map(mapRun),
      computer: toComputerStatus(target.botId, target.bot.computer, busyBotName),
    };
  }

  const core = await deps.prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR SHARE`;
      const [messagePage, last, activeRuns, recentTerminals] = await Promise.all([
        loadMessagePage(tx, target.threadId, undefined, THREAD_MESSAGE_PAGE_SIZE),
        tx.event.findFirst({
          where: { threadId: target.threadId },
          orderBy: { seq: "desc" },
          select: { seq: true },
        }),
        tx.run.findMany({
          where: {
            threadId: target.threadId,
            status: { in: [...ACTIVE_RUN_STATUSES] },
            // Waiting peer and ticket asks stay answerable. Busy ticket runs stay off
            // the transcript; only their waiting_input / waiting_takeover states surface.
            OR: [
              { trigger: { notIn: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] } },
              { status: { in: ["waiting_input", "waiting_takeover"] } },
            ],
          },
          orderBy: { createdAt: "desc" },
        }),
        // Recently updated terminals (completion bumps updatedAt). pickLatestTerminalRun then
        // ranks by completedAt ?? createdAt so null timestamps cannot revive a stale failure.
        tx.run.findMany({
          where: {
            threadId: target.threadId,
            trigger: { notIn: ["bot_message", ...BACKGROUND_RUN_TRIGGERS] },
            status: { in: ["failed", "completed", "cancelled"] },
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 50,
        }),
      ]);
      const liveEvents =
        activeRuns.length > 0
          ? await tx.event.findMany({
              where: {
                threadId: target.threadId,
                runId: { in: activeRuns.map((run) => run.id) },
                type: {
                  in: [
                    "thread.progress",
                    "thread.subagent",
                    "run.waiting_input",
                    "computer.takeover.requested",
                    "agent.tool.called",
                    "agent.tool.completed",
                  ],
                },
              },
              orderBy: { seq: "asc" },
            })
          : [];
      return {
        messagePage,
        last,
        activeRuns,
        terminalRun: pickLatestTerminalRun(recentTerminals),
        liveEvents,
      };
    },
    { timeout: 15_000, maxWait: 5_000 },
  );
  const primaryActiveRun = pickPrimaryActiveRun(core.activeRuns);
  return {
    groupId: target.groupId,
    groupName: target.groupName,
    members: target.members,
    threadId: target.threadId,
    cursor: core.last?.seq ?? -1,
    messages: messagesWithLiveEvents(core.messagePage.messages, core.liveEvents, core.activeRuns),
    olderCursor: core.messagePage.olderCursor,
    // Match the live reducer: a failed latest terminal stays in run even while siblings are
    // still active or start late. A newer completed/cancelled terminal clears it.
    run:
      core.terminalRun?.status === "failed"
        ? mapRun(core.terminalRun)
        : primaryActiveRun
          ? mapRun(primaryActiveRun)
          : null,
    activeRuns: core.activeRuns.map(mapRun),
  };
}

/** Keep waiting asks and takeovers in the group headline ahead of newer busy runs. */
function pickPrimaryActiveRun<T extends { status: string }>(runs: readonly T[]): T | undefined {
  return (
    runs.find((run) => run.status === "waiting_input" || run.status === "waiting_takeover") ??
    runs[0]
  );
}

/** Private threads prioritize takeover, then live work, while pending cards stay active. */
function pickPrimaryPrivateActiveRun<T extends { status: string }>(
  runs: readonly T[],
): T | undefined {
  return (
    runs.find((run) => run.status === "waiting_takeover") ??
    runs.find((run) => run.status === "running") ??
    runs.find((run) => run.status === "leased") ??
    runs[0]
  );
}

function pickLatestTerminalRun<T extends { id: string; createdAt: Date; completedAt: Date | null }>(
  runs: T[],
): T | null {
  if (runs.length === 0) return null;
  return runs.reduce((best, run) => {
    const bestEnd = (best.completedAt ?? best.createdAt).getTime();
    const runEnd = (run.completedAt ?? run.createdAt).getTime();
    if (runEnd !== bestEnd) return runEnd > bestEnd ? run : best;
    if (run.createdAt.getTime() !== best.createdAt.getTime()) {
      return run.createdAt > best.createdAt ? run : best;
    }
    return run.id > best.id ? run : best;
  });
}

function messagesWithLiveEvents(
  persisted: ThreadSnapshot["messages"],
  liveEvents: Parameters<typeof projectMessages>[0],
  runs: NonNullable<Parameters<typeof projectMessages>[1]>,
) {
  const live = projectMessages(liveEvents, runs).filter((message) => {
    if (message.blocks.some((block) => block.kind === "progress" || block.kind === "steps")) {
      return true;
    }
    if (!message.id.startsWith("subagent:")) return false;
    return !persisted.some((row) =>
      row.blocks.some(
        (block) => block.kind === "subagent" && message.id === `subagent:${block.agentId}`,
      ),
    );
  });
  return [...persisted, ...live];
}

function mapRun(run: {
  id: string;
  userId: string;
  botId: string;
  threadId: string;
  taskId: string;
  status: string;
  trigger: string;
  routineId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: run.id,
    userId: run.userId,
    botId: run.botId,
    threadId: run.threadId,
    taskId: run.taskId,
    status: run.status as never,
    trigger: run.trigger as never,
    routineId: run.routineId ?? null,
    modelProvider: run.modelProvider,
    modelId: run.modelId,
    // Same display clamp as live run.failed events so a huge stored error cannot bypass it.
    error:
      run.status === "failed"
        ? runFailureError({ type: "run.failed", payload: { error: run.error } })
        : run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

/**
 * Admit a confirmed image against the model each recipient run will use: the waiting runs this
 * text answers, otherwise the run that would take it as steering, otherwise the bot's default.
 */
async function assertImageRecipients(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: { threadId: string },
  text: string | undefined,
  attachmentBlocks: MessageBlock[],
  recipient: {
    botId: string;
    runs: Array<ImageAdmissionRun & { id: string }>;
    imageAdmission: Parameters<typeof assertThreadImageInput>[5];
  },
) {
  if (!attachmentBlocks.some((block) => block.kind === "image")) return;
  const { botId, runs } = recipient;
  const answered = [];
  for (const run of runs.filter((run) => run.status === "waiting_input")) {
    const eligible = await eligibleWaitingTextAnswer(tx, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      runId: run.id,
      answeredByUserId: actor.userId,
      answer: text ?? "",
    });
    if (eligible) answered.push(run);
  }
  const current =
    runs.find(steersUserMessage) ?? runs.find((run) => STEERABLE_RUN_STATUSES.has(run.status));
  for (const run of answered.length ? answered : [current]) {
    await assertThreadImageInput(
      tx as unknown as PrismaClient,
      actor,
      botId,
      attachmentBlocks,
      run && (isConversationalRun(run.trigger) || run.status === "waiting_input") ? run : undefined,
      recipient.imageAdmission,
    );
  }
}

/** Intent changes the message representation, never the owned artifact. */
function sendAttachmentBlocks(
  blocks: Extract<MessageBlock, { kind: "image" | "file" }>[],
  artifacts: Array<{ id: string; size: number }>,
  handling: "confirm" | "file" | undefined,
): Extract<MessageBlock, { kind: "image" | "file" }>[] {
  return blocks.map((block) => {
    if (block.kind !== "image") return block;
    if (handling === "file")
      return {
        ...block,
        kind: "file",
        size: artifacts.find((artifact) => artifact.id === block.artifactId)!.size,
      };
    return handling === "confirm" ? { ...block, imageHandling: "confirm" } : block;
  });
}

export async function sendThreadMessage(
  deps: {
    prisma: PrismaClient;
    events: ThreadEvents;
    jobs: JobPublisher;
    imageAdmission?: Parameters<typeof assertThreadImageInput>[5];
    maxAttachmentsPerMessage?: number;
    analytics?: ProductAnalytics;
  },
  actor: Actor,
  target: ThreadTarget,
  input: {
    text?: string;
    artifactIds?: string[];
    imageHandling?: "confirm" | "file";
    mentions?: MentionTargetInput[];
    replyToMessageId?: string;
    replyQuote?: string;
    clientNonce?: string;
  },
  releaseTakeover?: (runId: string) => Promise<void>,
  /** Runs saved with the message, after the thread lock and before the message is routed. */
  startRoutines?: (tx: Prisma.TransactionClient) => Promise<Array<{ id: string; status: string }>>,
) {
  const existing = await replayExistingSend(
    deps,
    target.threadId,
    input.clientNonce,
    releaseTakeover,
  );
  if (existing) return existing;
  // Live events carry the call id so a spoken turn joins the call card on first
  // paint; without it the bubble shows loose until a refetch reads the nonce.
  const callId = callIdFromClientNonce(input.clientNonce);
  const requestedReplyQuote = input.replyQuote?.trim() || undefined;
  if (requestedReplyQuote && !input.replyToMessageId) {
    throw new ORPCError("BAD_REQUEST", { message: "replyQuote requires replyToMessageId." });
  }

  const commit = () =>
    deps.prisma.$transaction(async (tx) => {
      let routineRuns: Array<{ id: string; status: string }> = [];
      let replyToMessageId: string | undefined;
      let replyQuote: string | undefined;
      let replyPreview: ReplyPreview | null | undefined;
      if (input.replyToMessageId) {
        const reply = await tx.message.findFirst({
          where: { id: input.replyToMessageId, threadId: target.threadId },
          select: { id: true, blocks: true, role: true, botId: true },
        });
        // A missing target must not lose the send or retain an unverified id.
        // The empty server-owned quote preserves the unavailable state after reload.
        if (!reply) {
          replyQuote = "";
          replyPreview = null;
        } else {
          replyToMessageId = input.replyToMessageId;
          const parsed = MessageBlockSchema.array().safeParse(reply.blocks);
          replyPreview = null;
          if (parsed.success) {
            replyPreview = messageReplyPreview(
              parsed.data,
              reply.role as ReplyPreview["role"],
              reply.botId ?? undefined,
            );
            // Attachment labels stay in the preview; only selected text is persisted as a quote.
            if (!requestedReplyQuote && !replyPreview.attachment) {
              replyQuote = replyPreview.text || undefined;
            }
          }
          // Persist only text derived from the authoritative parent. A
          // mismatch or a derivation failure still sends a plain reply so
          // quote verification cannot lose a message.
          if (requestedReplyQuote && parsed.success) {
            try {
              replyQuote = deriveMessageQuote(
                parsed.data,
                requestedReplyQuote,
                reply.role === "user" ? "plain-text" : "markdown",
              );
            } catch (error) {
              getLogger().error("thread send quote derivation", error);
              replyQuote = undefined;
            }
          }
        }
      }

      if (target.kind === "bot") {
        const mentionTargets = splitMentionTargets(input.mentions);
        const { blocks: attachmentBlocks, artifacts } = await resolveSendAttachments(
          { prisma: tx, maxAttachmentsPerMessage: deps.maxAttachmentsPerMessage },
          actor,
          target.botId,
          input.artifactIds,
        );
        const connectorNames = await resolveOwnedConnectorDisplayNames(
          tx,
          actor,
          mentionTargets.connectorMentionIds,
        );
        // Match message counter locking before inspecting runs, without changing counters on rejection.
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
        routineRuns = (await startRoutines?.(tx)) ?? [];
        const activeRuns = await tx.run.findMany({
          where: {
            threadId: target.threadId,
            botId: target.botId,
            status: { in: [...ACTIVE_RUN_STATUSES] },
          },
          select: {
            id: true,
            taskId: true,
            status: true,
            trigger: true,
            modelProvider: true,
            modelId: true,
            modelPinned: true,
            thinkingLevel: true,
          },
        });
        if (input.imageHandling === "confirm") {
          await assertImageRecipients(tx, actor, target, input.text, attachmentBlocks, {
            botId: target.botId,
            runs: activeRuns,
            imageAdmission: deps.imageAdmission,
          });
        }
        const blocks = buildUserMessageBlocks(
          input.text,
          sendAttachmentBlocks(attachmentBlocks, artifacts, input.imageHandling),
        );
        const message = await createThreadMessageInTransaction(tx, {
          threadId: target.threadId,
          role: "user",
          blocks,
          replyToMessageId,
          replyQuote,
          clientNonce: input.clientNonce,
        });
        const answered: typeof activeRuns = [];
        for (const run of activeRuns.filter((run) => run.status === "waiting_input")) {
          if (
            await answerWaitingRunWithTextInTransaction(tx, {
              spaceId: actor.spaceId,
              threadId: target.threadId,
              runId: run.id,
              answeredByUserId: actor.userId,
              answer: input.text ?? "",
              beforeMessageSeq: message.seq,
            })
          )
            answered.push({ ...run, status: "queued" });
          else
            await retireWaitingQuestionInTransaction(tx, {
              spaceId: actor.spaceId,
              threadId: target.threadId,
              botId: target.botId,
              runId: run.id,
              answer: input.text ?? "",
            });
        }
        if (answered.length) {
          const primary = answered[0];
          if (!primary) throw new IsolationError();
          await tx.message.update({ where: { id: message.id }, data: { runId: primary.id } });
          const steered = answered.filter((run) =>
            answerSteersRun(run, attachmentBlocks, input.imageHandling),
          );
          for (const run of steered) {
            await tx.steeringMessage.create({
              data: {
                messageId: message.id,
                botId: target.botId,
                userId: actor.userId,
                runId: run.id,
              },
            });
          }
          const event = await appendEventInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: target.threadId,
            botId: target.botId,
            type: "thread.message.created",
            runId: primary.id,
            payload: {
              messageId: message.id,
              seq: message.seq,
              role: "user",
              blocks,
              callId,
              runIds: answered.map((run) => run.id),
              replyToMessageId,
              replyQuote,
              replyPreview,
            },
          });
          return { message, runs: answered, routineRuns, eventSeq: event.seq };
        }
        const holdingRuns = activeRuns.filter(
          (run) =>
            QUEUE_HOLDING_RUN_STATUSES.some((status) => status === run.status) &&
            !messageBypassesTakeoverWait(run),
        );
        const active = holdingRuns.find(steersUserMessage) ?? holdingRuns[0];
        if (active) {
          await tx.steeringMessage.create({
            data: {
              messageId: message.id,
              botId: target.botId,
              userId: actor.userId,
              runId: steersUserMessage(active) ? active.id : null,
            },
          });
          await tx.message.update({ where: { id: message.id }, data: { runId: active.id } });
          const event = await appendEventInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: target.threadId,
            botId: target.botId,
            type: "thread.message.created",
            runId: active.id,
            payload: {
              messageId: message.id,
              seq: message.seq,
              role: "user",
              blocks,
              callId,
              replyToMessageId,
              replyQuote,
              replyPreview,
            },
          });
          return { message, runs: [active], routineRuns, eventSeq: event.seq };
        }
        const task = await tx.task.create({
          data: {
            spaceId: actor.spaceId,
            botId: target.botId,
            threadId: target.threadId,
            userId: actor.userId,
            prompt: buildSendPrompt(input.text, artifacts, connectorNames),
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: actor.spaceId,
            botId: target.botId,
            threadId: target.threadId,
            taskId: task.id,
            userId: actor.userId,
            status: "queued",
            trigger: "user",
            clientNonce: sendRunClientNonce(input.clientNonce, message.id),
            sourceMessageId: message.id,
          },
        });
        await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
        await cancelSupersededQueuedRuns(tx, {
          threadId: target.threadId,
          botIds: [target.botId],
          keepRunIds: [run.id],
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: actor.spaceId,
          threadId: target.threadId,
          botId: target.botId,
          type: "thread.message.created",
          runId: run.id,
          payload: {
            messageId: message.id,
            seq: message.seq,
            role: "user",
            blocks,
            callId,
            runIds: [run.id],
            replyToMessageId,
            replyQuote,
            replyPreview,
          },
        });
        return { message, runs: [run], routineRuns, eventSeq: event.seq };
      }

      const members = await lockAndLoadGroupMembers(tx, actor, target);
      const memberBotIds = members.map((member) => member.botId);
      const mentionTargets = splitMentionTargets(input.mentions);
      const targetBotIds = sendTargetBotIds({ kind: "group", members }, input);
      const { blocks: attachmentBlocks, artifacts } = await resolveGroupSendAttachments(
        { prisma: tx, maxAttachmentsPerMessage: deps.maxAttachmentsPerMessage },
        actor,
        target.groupId,
        memberBotIds,
        input.artifactIds,
      );
      const connectorNames = await resolveOwnedConnectorDisplayNames(
        tx,
        actor,
        mentionTargets.connectorMentionIds,
      );
      // Group ownership is locked first, then the thread, as in the normal write path.
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
      routineRuns = (await startRoutines?.(tx)) ?? [];
      const activeRuns = await tx.run.findMany({
        where: {
          threadId: target.threadId,
          botId: { in: targetBotIds },
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: {
          id: true,
          taskId: true,
          botId: true,
          status: true,
          trigger: true,
          modelProvider: true,
          modelId: true,
          modelPinned: true,
          thinkingLevel: true,
        },
      });
      if (input.imageHandling === "confirm") {
        for (const botId of targetBotIds) {
          await assertImageRecipients(tx, actor, target, input.text, attachmentBlocks, {
            botId,
            runs: activeRuns.filter((run) => run.botId === botId),
            imageAdmission: deps.imageAdmission,
          });
        }
      }
      const blocks = buildUserMessageBlocks(
        input.text,
        sendAttachmentBlocks(attachmentBlocks, artifacts, input.imageHandling),
      );
      const message = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "user",
        blocks,
        replyToMessageId,
        replyQuote,
        clientNonce: input.clientNonce,
      });
      const activeByBotId = new Map<string, (typeof activeRuns)[number]>();
      const answeredByBotId = new Map<string, Array<(typeof activeRuns)[number]>>();
      for (const run of activeRuns) {
        if (run.status === "waiting_input") {
          const answered = await answerWaitingRunWithTextInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: target.threadId,
            runId: run.id,
            answeredByUserId: actor.userId,
            answer: input.text ?? "",
            beforeMessageSeq: message.seq,
          });
          if (answered) {
            const queuedForBot = answeredByBotId.get(run.botId) ?? [];
            queuedForBot.push({ ...run, status: "queued" });
            answeredByBotId.set(run.botId, queuedForBot);
          } else {
            await retireWaitingQuestionInTransaction(tx, {
              spaceId: actor.spaceId,
              threadId: target.threadId,
              botId: run.botId,
              runId: run.id,
              answer: input.text ?? "",
            });
          }
          continue;
        }
        if (!STEERABLE_RUN_STATUSES.has(run.status) || messageBypassesTakeoverWait(run)) continue;
        const current = activeByBotId.get(run.botId);
        if (!current || (!steersUserMessage(current) && steersUserMessage(run))) {
          activeByBotId.set(run.botId, run);
        }
      }
      const runs: Array<{ id: string; taskId: string; botId: string; status: string }> = [];
      for (const botId of targetBotIds) {
        const answered = answeredByBotId.get(botId);
        if (answered) {
          const steered = answered.filter((run) =>
            answerSteersRun(run, attachmentBlocks, input.imageHandling),
          );
          for (const run of steered) {
            await tx.steeringMessage.create({
              data: { messageId: message.id, botId, userId: actor.userId, runId: run.id },
            });
          }
          runs.push(...answered);
          continue;
        }
        const active = activeByBotId.get(botId);
        if (active) {
          await tx.steeringMessage.create({
            data: {
              messageId: message.id,
              botId,
              userId: actor.userId,
              runId: steersUserMessage(active) ? active.id : null,
            },
          });
          runs.push(active);
          continue;
        }
        const task = await tx.task.create({
          data: {
            spaceId: actor.spaceId,
            botId,
            threadId: target.threadId,
            userId: actor.userId,
            prompt: buildSendPrompt(input.text, artifacts, connectorNames),
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: actor.spaceId,
            botId,
            threadId: target.threadId,
            taskId: task.id,
            userId: actor.userId,
            status: "queued",
            trigger: "user",
            clientNonce: sendRunClientNonce(input.clientNonce, message.id, botId),
            sourceMessageId: message.id,
          },
        });
        runs.push(run);
      }
      const firstRun = runs[0];
      const eventBotId = firstRun?.botId ?? targetBotIds[0];
      if (!eventBotId) throw new IsolationError("Group send did not resolve a target");
      if (firstRun) {
        await tx.message.update({ where: { id: message.id }, data: { runId: firstRun.id } });
        const createdRuns = runs.filter(
          (run) => !activeByBotId.has(run.botId) && !answeredByBotId.has(run.botId),
        );
        if (createdRuns.length) {
          await cancelSupersededQueuedRuns(tx, {
            threadId: target.threadId,
            botIds: createdRuns.map((run) => run.botId),
            keepRunIds: createdRuns.map((run) => run.id),
          });
        }
      }
      await touchGroupUpdatedAt(tx, target.groupId);
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: eventBotId,
        type: "thread.message.created",
        runId: firstRun?.id ?? activeRuns[0]?.id,
        payload: {
          messageId: message.id,
          seq: message.seq,
          role: "user",
          blocks,
          callId,
          runIds: runs.map((run) => run.id),
          replyToMessageId,
          replyQuote,
          replyPreview,
        },
      });
      return { message, runs, routineRuns, eventSeq: event.seq };
    });

  const committed = await withSerializableRetry(commit).catch(async (error) => {
    const winner = await replayExistingSend(
      deps,
      target.threadId,
      input.clientNonce,
      releaseTakeover,
    );
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  deps.analytics?.capture(
    actor.userId,
    { name: "message_sent", trigger: "user" },
    { id: committed.message.id, at: committed.message.createdAt },
  );
  await deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
    // Subscribers catch up from the durable event cursor after a missed realtime wake.
    getLogger().error("thread send realtime notification", error);
  });
  if (releaseTakeover) {
    for (const run of committed.runs) {
      if (steersUserMessage(run)) await releaseTakeover(run.id);
    }
  }
  await enqueueRunsNeedingContinue(deps.jobs, [...committed.routineRuns, ...committed.runs]);
  return sendResult(committed.message, committed.runs);
}

const REACTION_TURN_COOLDOWN_MS = 30_000;

/**
 * Append a human emoji reply with its target. Any reaction to the bot's latest
 * message may wake it, with silence allowed. Only thumbs answer an ordinary pending
 * ask; busy bots, recent reaction turns, and older targets stay quiet context.
 * A 👍 on a pending takeover counts as done and hands computer control back.
 * Approval and secret asks remain on their cards. Reactions are append-only.
 */
export async function reactToThreadMessage(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  actor: Actor,
  target: ThreadTarget,
  input: {
    messageId: string;
    reaction: MessageReaction;
    clientNonce: string;
    /** False when a send to the reacted-to bot could not start a run either (no model, teaching). */
    mayStartTurn: boolean;
  },
  releaseTakeover?: (runId: string) => Promise<void>,
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const parent = await tx.message.findFirst({
      where: { id: input.messageId, threadId: target.threadId },
      select: { id: true, seq: true, role: true, botId: true, runId: true },
    });
    if (!parent) throw new IsolationError();
    const existing = await tx.message.findUnique({
      where: {
        threadId_clientNonce: { threadId: target.threadId, clientNonce: input.clientNonce },
      },
      select: { id: true },
    });
    if (existing) {
      // A retry finishes a takeover handoff whose release failed after the 👍 was saved.
      const steering = releaseTakeover
        ? await tx.steeringMessage.findFirst({
            where: { messageId: existing.id, claimedAt: null },
            select: { run: { select: { id: true, taskId: true, status: true } } },
          })
        : null;
      const run = steering?.run;
      return { eventSeq: null, runs: run?.status === "waiting_takeover" ? [run] : [] };
    }
    const members =
      target.kind === "group" ? await lockAndLoadGroupMembers(tx, actor, target) : undefined;
    const currentTarget = members
      ? { ...target, memberBotIds: members.map((member) => member.botId) }
      : target;
    const replyBotId = input.mayStartTurn
      ? await reactionReplyBotId(tx, currentTarget, parent)
      : undefined;
    const botId =
      replyBotId ??
      (currentTarget.kind === "bot" ? currentTarget.botId : currentTarget.memberBotIds[0]);
    if (!botId) throw new IsolationError();
    const blocks: MessageBlock[] = [{ kind: "text", text: input.reaction }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role: "user",
      blocks,
      replyToMessageId: parent.id,
      clientNonce: input.clientNonce,
    });
    const runs = replyBotId
      ? await startReactionTurn(tx, actor, target.threadId, replyBotId, parent, message, {
          ...input,
          canReleaseTakeover: Boolean(releaseTakeover),
        })
      : [];
    if (target.kind === "group") await touchGroupUpdatedAt(tx, target.groupId);
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      botId,
      type: "thread.message.created",
      ...(runs[0] ? { runId: runs[0].id } : {}),
      payload: {
        messageId: message.id,
        role: "user",
        blocks,
        replyToMessageId: parent.id,
        ...(runs.length ? { runIds: runs.map((run) => run.id) } : {}),
      },
    });
    return { eventSeq: event.seq, runs };
  });
  if (releaseTakeover) {
    for (const run of committed.runs) {
      if (run.status === "waiting_takeover") await releaseTakeover(run.id);
    }
  }
  await enqueueRunsNeedingContinue(deps.jobs, committed.runs);
  return { eventSeq: committed.eventSeq, runIds: committed.runs.map((run) => run.id) };
}

/** The bot that wrote the thread's newest message, when the reaction targets that message. */
async function reactionReplyBotId(
  tx: Prisma.TransactionClient,
  target: ThreadTarget,
  parent: { seq: number; role: string; botId: string | null },
) {
  // Only the authenticated human reaction route calls this path; bots cannot wake each other.
  if (parent.role !== "bot" || !parent.botId) return undefined;
  const memberBotIds = target.kind === "bot" ? [target.botId] : target.memberBotIds;
  if (!memberBotIds.includes(parent.botId)) return undefined;
  // Earlier reactions may follow it; any other message means the conversation moved on.
  const newer = await tx.message.findMany({
    where: { threadId: target.threadId, seq: { gt: parent.seq } },
    orderBy: { seq: "asc" },
    take: 51,
    select: { role: true, blocks: true, replyToMessageId: true },
  });
  if (newer.length > 50) return undefined;
  const onlyReactions = newer.every((message) =>
    messageReaction({
      ...message,
      blocks: Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [],
    }),
  );
  return onlyReactions ? parent.botId : undefined;
}

async function startReactionTurn(
  tx: Prisma.TransactionClient,
  actor: Actor,
  threadId: string,
  botId: string,
  parent: { id: string; runId: string | null },
  message: { id: string; seq: number },
  input: { reaction: MessageReaction; clientNonce: string; canReleaseTakeover: boolean },
): Promise<Array<{ id: string; taskId: string; status: string }>> {
  const activeRuns = await tx.run.findMany({
    where: { threadId, botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true, taskId: true, status: true },
  });
  const holdingRuns = activeRuns.filter((run) =>
    QUEUE_HOLDING_RUN_STATUSES.some((status) => status === run.status),
  );
  const active = activeRuns.find((run) => run.id === parent.runId) ?? holdingRuns[0];
  const others = holdingRuns.filter((run) => run.id !== active?.id);
  if (active) {
    // A 👍 while this run waits for the user to finish on the computer means "done", the
    // same as a typed reply: it steers the run and the caller hands control back.
    // Only when the caller can hand control back (bot threads), as with a typed reply.
    if (
      input.canReleaseTakeover &&
      input.reaction === "👍" &&
      !others.length &&
      active.status === "waiting_takeover" &&
      active.id === parent.runId
    ) {
      await tx.steeringMessage.create({
        data: { messageId: message.id, botId, userId: actor.userId, runId: active.id },
      });
      await tx.message.update({ where: { id: message.id }, data: { runId: active.id } });
      return [active];
    }
    if (
      (input.reaction === "👍" || input.reaction === "👎") &&
      active.status === "waiting_input" &&
      active.id === parent.runId
    ) {
      const answered = await answerWaitingRunWithTextInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId,
        runId: active.id,
        answeredByUserId: actor.userId,
        answer: input.reaction === "👍" ? "yes" : "no",
        messageId: parent.id,
      });
      if (answered) {
        await tx.message.update({ where: { id: message.id }, data: { runId: active.id } });
        return [{ ...active, status: "queued" }];
      }
      // Approval and secret cards still require an explicit card answer.
      return [];
    }
    if (holdingRuns.length) return [];
  }
  // The cooldown limits new turns only, so a quick answer to a pending ask still goes through.
  const recentReaction = await tx.run.findFirst({
    where: {
      threadId,
      botId,
      trigger: "reaction",
      status: { not: "cancelled" },
      createdAt: { gte: new Date(Date.now() - REACTION_TURN_COOLDOWN_MS) },
    },
    select: { id: true },
  });
  if (recentReaction) return [];
  const task = await tx.task.create({
    data: {
      spaceId: actor.spaceId,
      botId,
      threadId,
      userId: actor.userId,
      prompt: input.reaction,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: actor.spaceId,
      botId,
      threadId,
      taskId: task.id,
      userId: actor.userId,
      status: "queued",
      trigger: "reaction",
      clientNonce: sendRunClientNonce(input.clientNonce, message.id),
      sourceMessageId: message.id,
    },
  });
  await tx.message.update({ where: { id: message.id }, data: { runId: run.id } });
  await cancelSupersededQueuedRuns(tx, { threadId, botIds: [botId], keepRunIds: [run.id] });
  return [run];
}

export async function stopThreadRuns(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    events: ThreadEvents;
  },
  actor: Actor,
  target: ThreadTarget,
) {
  const { runIds, computers, leases, eventSeq } = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const cancelled = await tx.run.updateManyAndReturn({
      where: {
        threadId: target.threadId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      data: { status: "cancelled", completedAt: new Date() },
      select: { id: true, botId: true, userId: true, spaceId: true },
    });
    const ids = cancelled.map((run) => run.id);
    await clearEndedRunState(tx, ids);
    await tx.steeringMessage.deleteMany({
      where: {
        botId: { in: target.kind === "bot" ? [target.botId] : target.memberBotIds },
        message: { threadId: target.threadId },
      },
    });
    // Snapshot teardown coordinates before commit. Once cancellation becomes
    // visible, a worker can release its lease / execution columns immediately; a
    // later lookup would then miss the sandbox work this request must stop.
    // Team ownership lives on ComputerExecutionLease; Computer.executionRunId is
    // only a legacy secondary path and is not written by current acquisition.
    const leases = ids.length
      ? await tx.computerExecutionLease.findMany({
          where: { runId: { in: ids } },
          select: { computerId: true, botId: true, runId: true, fence: true },
        })
      : [];
    const leaseComputerIds = [...new Set(leases.map((lease) => lease.computerId))];
    const computers = ids.length
      ? await tx.computer.findMany({
          where:
            leaseComputerIds.length > 0
              ? {
                  OR: [{ id: { in: leaseComputerIds } }, { executionRunId: { in: ids } }],
                }
              : { executionRunId: { in: ids } },
          select: {
            id: true,
            homeKey: true,
            kind: true,
            providerRef: true,
            executionBotId: true,
            executionRunId: true,
          },
        })
      : [];
    // One terminal event per cancelled run, in the same commit as the status
    // flip and the progress purge below. Other clients learn the run ended, and
    // the fresh seq keeps max(seq) above every deleted progress row so a client
    // whose cursor pointed at one never discards later refreshes as stale.
    let eventSeq: number | null = null;
    for (const run of cancelled) {
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: run.botId,
        type: "run.cancelled",
        runId: run.id,
        payload: {},
      });
      eventSeq = event.seq;
    }
    if (ids.length) {
      await tx.event.deleteMany({
        where: {
          ...transientRunEventsWhere(),
          runId: { in: ids },
        },
      });
    }
    return { runIds: ids, computers, leases, eventSeq };
  });
  if (eventSeq !== null) {
    // The events are durable; subscribers refetch from their persisted cursor.
    await deps.events.notify(target.threadId, eventSeq).catch((error) => {
      getLogger().error("thread stop realtime notification", error);
    });
  }
  // Keep the DB lease until after teardown so a replacement run cannot claim the
  // screen while we still need the cancelled run's screenLeaseId to release it.
  const computerById = new Map(computers.map((computer) => [computer.id, computer]));
  const teardownTargets: Array<{
    computer: (typeof computers)[number];
    botId: string;
    runId: string;
    lease: (typeof leases)[number] | null;
  }> = [];
  const seenTargets = new Set<string>();
  for (const lease of leases) {
    const computer = computerById.get(lease.computerId);
    if (!computer) continue;
    const key = `${computer.id}:${lease.runId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    teardownTargets.push({
      computer,
      botId: lease.botId,
      runId: lease.runId,
      lease,
    });
  }
  const cancelledRunIds = new Set(runIds);
  for (const computer of computers) {
    if (!computer.executionBotId || !computer.executionRunId) continue;
    // Computers may enter the snapshot via a cancelled lease while
    // Computer.executionRunId still points at an unrelated live run. Only treat
    // the legacy columns as a teardown target when they belong to a run we
    // cancelled in this transaction.
    if (!cancelledRunIds.has(computer.executionRunId)) continue;
    const key = `${computer.id}:${computer.executionRunId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    teardownTargets.push({
      computer,
      botId: computer.executionBotId,
      runId: computer.executionRunId,
      lease: null,
    });
  }
  await Promise.all(
    teardownTargets.map(async ({ computer, botId, runId, lease }) => {
      if (!computer.providerRef) return;
      const context = {
        operationId: "stop",
        traceId: "stop",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        runId,
        screenLeaseId: screenLeaseIdForRun(lease, runId),
        cancelRunWork: true,
        signal: new AbortController().signal,
      };
      const ref = toComputerRef(computer);
      await cancelComputerRunWork(deps.sandbox, ref, computer.id, runId, context);
      await deps.sandbox.releaseScreen?.(ref, context).catch(() => undefined);
    }),
  );
  await expireComputerExecutionLeases(deps.prisma, { runId: { in: runIds } });
  await deps.prisma.computer.updateMany({
    where: { executionRunId: { in: runIds } },
    data: {
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
    },
  });
}

/**
 * Marks the thread read up to its latest message. Returns the seq the user had read up
 * to before, or null when the chat wasn't unread or nothing new arrived; the first
 * answer of a visit places the "New" divider. A message landing mid-update makes the
 * conditional write miss, so it retries rather than marking that message read; a chat
 * that stays that busy is read under the thread's row lock instead.
 */
export async function markThreadRead(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
): Promise<number | null> {
  const where = { id: target.threadId, spaceId: actor.spaceId, userId: actor.userId };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const thread = await prisma.thread.findFirst({
      where,
      select: { unread: true, lastReadSeq: true, nextMessageSeq: true },
    });
    if (!thread) return null;
    const latestSeq = thread.nextMessageSeq - 1;
    if (!thread.unread && thread.lastReadSeq >= latestSeq) return null;
    const result = await prisma.thread.updateMany({
      where: { ...where, lastReadSeq: thread.lastReadSeq, nextMessageSeq: thread.nextMessageSeq },
      data: { unread: false, lastReadSeq: latestSeq },
    });
    if (result.count > 1) throw new IsolationError();
    if (result.count === 1) return dividerSeq(thread, latestSeq);
  }
  // New messages take the same row lock, so none can land between this read and write.
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const thread = await tx.thread.findFirst({
      where,
      select: { unread: true, lastReadSeq: true, nextMessageSeq: true },
    });
    if (!thread) return null;
    const latestSeq = thread.nextMessageSeq - 1;
    if (!thread.unread && thread.lastReadSeq >= latestSeq) return null;
    const result = await tx.thread.updateMany({
      where,
      data: { unread: false, lastReadSeq: latestSeq },
    });
    if (result.count > 1) throw new IsolationError();
    return dividerSeq(thread, latestSeq);
  });
}

/** A chat only gets a divider when its unread dot was on, so replies seen live never do. */
function dividerSeq(thread: { unread: boolean; lastReadSeq: number }, latestSeq: number) {
  return thread.unread && thread.lastReadSeq < latestSeq ? thread.lastReadSeq : null;
}

/**
 * Marks the thread unread from one of its messages: the read cursor moves to just before it,
 * so the next open puts the New divider above that message.
 */
export async function markThreadUnreadFrom(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  messageId: string,
) {
  const message = await prisma.message.findFirst({
    where: { id: messageId, threadId: target.threadId },
    select: { seq: true },
  });
  if (!message) throw new ORPCError("NOT_FOUND");
  const result = await prisma.thread.updateMany({
    where: { id: target.threadId, spaceId: actor.spaceId, userId: actor.userId },
    data: { unread: true, lastReadSeq: message.seq - 1 },
  });
  if (result.count > 1) throw new IsolationError();
}

export async function setThreadUnreadState(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  unread: boolean,
) {
  const result = await prisma.thread.updateMany({
    where: {
      id: target.threadId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      unread: { not: unread },
    },
    data: { unread },
  });
  if (result.count > 1) throw new IsolationError();
}
