import type { Actor, RunActivityRow, RunStatus, RunTrigger } from "@rakazo/contracts";
import { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  BACKGROUND_RUN_TRIGGERS,
  botMessageContext,
  displayName,
  HELPER_RESULT_TRIGGER,
  isApprovalAskBlock,
  truncatePlainText,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, readMessageBlocks } from "@rakazo/db";

const RECENT_LIMIT = 20;
// Background ticket work belongs on the board, not in the activity list. A background helper and
// the turn passing on its result show in the chat, on the helper's card.
const ACTIVITY_HIDDEN_TRIGGERS = [
  ...BACKGROUND_RUN_TRIGGERS,
  BACKGROUND_HELPER_TRIGGER,
  HELPER_RESULT_TRIGGER,
] as const;
// The prompt of these runs is written by the product, not the user, so it is no preview.
const SYSTEM_PROMPT_TRIGGERS: readonly string[] = [
  "created",
  "call_end",
] as const satisfies readonly RunTrigger[];
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

function promptSnippet(prompt: string, max = 120): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${truncatePlainText(oneLine, max - 1)}…`;
}

export function activityPreview(
  input: { trigger: string; prompt: string; sourceBlocks?: unknown },
  max = 120,
): Pick<RunActivityRow, "promptSnippet" | "agentMessage"> {
  if (SYSTEM_PROMPT_TRIGGERS.includes(input.trigger))
    return { promptSnippet: "", agentMessage: null };
  if (input.trigger !== "bot_message")
    return { promptSnippet: promptSnippet(input.prompt, max), agentMessage: null };
  const parsed = MessageBlock.array().safeParse(input.sourceBlocks);
  const message = parsed.success ? botMessageContext(parsed.data) : undefined;
  if (!message) {
    return {
      promptSnippet: "Message from another agent",
      agentMessage: { kind: "unknown" },
    };
  }
  const name = displayName(message.fromBotName, "Another agent");
  const kind =
    message.intent === "result" || message.intent === "status" || message.intent === "fyi"
      ? "update"
      : "request";
  const label = kind === "update" ? `Update from ${name}` : `${name} asked`;
  return {
    promptSnippet: promptSnippet(message.text.trim() ? `${label}: ${message.text}` : label, max),
    agentMessage: {
      fromBotName: displayName(message.fromBotName, ""),
      kind,
      text: promptSnippet(message.text, max),
    },
  };
}

export function activityNotificationsEnabled(
  groupId: string | null,
  notifyOnFinish: boolean,
): boolean {
  return groupId !== null || notifyOnFinish;
}

/** Above this detail length the card must be read in full, so the list offers Open/Deny only. */
export const INLINE_APPROVAL_DETAIL_MAX = 280;

type ApprovalAskBlock = Extract<MessageBlock, { kind: "ask" }>;

/**
 * The approval card among a message's blocks, read the way every other reader reads them: the
 * stored row through `readMessageBlocks`, then the card's own fields through the block schema.
 * A row that lost entries proves nothing about what it still holds, so it offers no card.
 */
function approvalAskBlock(message: { id: string; blocks: unknown }): ApprovalAskBlock | null {
  const { blocks, intact } = readMessageBlocks(message);
  if (!intact) return null;
  const block = blocks.find((entry) => entry.kind === "ask");
  const parsed = MessageBlock.safeParse(block);
  return parsed.success && parsed.data.kind === "ask" ? parsed.data : null;
}

/**
 * The pending approval card to answer from the Activity list (#4181), or null when the run has
 * none. `inlineAllow` is false for once-only cards (explicit approval / purchase) and for a card
 * whose detail, receipt or extra fields cannot be shown whole in the row: those are opened and
 * read in full before allowing, so the owner never approves a target the row did not show.
 */
export function pendingApprovalFromBlocks(message: {
  id: string;
  blocks: unknown;
}): NonNullable<RunActivityRow["pendingApproval"]> | null {
  const ask = approvalAskBlock(message);
  if (!ask) return null;
  if (ask.status === "answered" || ask.dismissed) return null;
  if (!isApprovalAskBlock(ask)) return null;
  const detail = ask.detail ?? null;
  const shownWhole =
    detail === null ||
    (detail.length <= INLINE_APPROVAL_DETAIL_MAX && (ask.detailFormat ?? "text") === "text");
  // Anything the row cannot render — a receipt, a login or secret form, a settings/instruction
  // diff — has to be read on the card itself.
  const carriesUnshownFields = Boolean(
    ask.receipt ||
      ask.input ||
      ask.credential ||
      ask.oneTimeCode ||
      ask.replaces ||
      ask.loginFields ||
      ask.instructionUpdate ||
      ask.settingsUpdate,
  );
  const inlineAllow =
    shownWhole &&
    !carriesUnshownFields &&
    (ask.actions ?? []).some((action) => action.id === "always");
  return { messageId: message.id, text: ask.text, detail, inlineAllow };
}

/** How many of a waiting run's newest messages the list reads to find its card. */
const WAITING_APPROVAL_SCAN = 5;

/**
 * Each waiting run's pending card, from its newest message that carries one. A run keeps waiting
 * while ordinary messages arrive after the card, so the scan covers a few newest rows rather than
 * the run's whole history; a card already answered or dismissed never comes back.
 */
async function pendingApprovalsByRun(
  prisma: PrismaClient,
  runIds: readonly string[],
): Promise<Map<string, NonNullable<RunActivityRow["pendingApproval"]>>> {
  const found = new Map<string, NonNullable<RunActivityRow["pendingApproval"]>>();
  if (runIds.length === 0) return found;
  const messages = await prisma.message.findMany({
    where: { runId: { in: [...runIds] } },
    orderBy: { seq: "desc" },
    select: { runId: true, id: true, blocks: true },
  });
  const scanned = new Map<string, number>();
  for (const message of messages) {
    const runId = message.runId;
    if (!runId || found.has(runId)) continue;
    const seen = (scanned.get(runId) ?? 0) + 1;
    scanned.set(runId, seen);
    if (seen > WAITING_APPROVAL_SCAN) continue;
    const approval = pendingApprovalFromBlocks(message);
    if (approval) found.set(runId, approval);
  }
  return found;
}

export async function listSpaceRuns(
  prisma: PrismaClient,
  actor: Actor,
  filter: "active" | "recent",
  status?: RunStatus,
): Promise<RunActivityRow[]> {
  const sectionStatuses: readonly RunStatus[] =
    filter === "active" ? ACTIVE_RUN_STATUSES : TERMINAL_STATUSES;
  if (status && !sectionStatuses.includes(status)) return [];
  const statuses = status ? [status] : [...sectionStatuses];
  const rows = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      bot: { archivedAt: null },
      trigger: { notIn: [...ACTIVITY_HIDDEN_TRIGGERS] },
      status: { in: statuses },
      ...(filter === "recent"
        ? { id: { in: await latestFinishedRunPerChat(prisma, actor, statuses) } }
        : {}),
    },
    include: {
      bot: { select: { name: true, archivedAt: true, notifyOnFinish: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
      thread: {
        select: {
          groupId: true,
          group: { select: { name: true } },
        },
      },
    },
    orderBy:
      filter === "active"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : [{ completedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
  });

  // Owner-only: surface a waiting run's pending approval card so the Activity list can
  // answer Allow-once / Deny inline (#4181). Other members' runs never carry the card.
  const waitingOwn = rows.filter(
    (row) => row.status === "waiting_input" && row.userId === actor.userId,
  );
  const approvalByRun = await pendingApprovalsByRun(
    prisma,
    waitingOwn.map((row) => row.id),
  );

  return rows.map((row) => ({
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    groupId: row.thread.groupId,
    groupName: row.thread.group ? row.thread.group.name : null,
    threadId: row.threadId,
    status: row.status as RunActivityRow["status"],
    trigger: row.trigger as RunActivityRow["trigger"],
    notificationsEnabled: activityNotificationsEnabled(row.thread.groupId, row.bot.notifyOnFinish),
    ...activityPreview({
      trigger: row.trigger,
      prompt: row.task.prompt,
      sourceBlocks: row.sourceMessage?.blocks,
    }),
    updatedAt: (filter === "recent" && row.completedAt
      ? row.completedAt
      : row.updatedAt
    ).toISOString(),
    pendingApproval: approvalByRun.get(row.id) ?? null,
  }));
}

/** Recent lists chats keyed like `activitySections`, so one busy chat must not push the others out of the limit. */
async function latestFinishedRunPerChat(
  prisma: PrismaClient,
  actor: Actor,
  statuses: RunStatus[],
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM (
      SELECT DISTINCT ON (COALESCE('group:' || t."groupId", 'bot:' || r."botId")) r.id, r."completedAt", r."updatedAt"
      FROM runs r
      JOIN threads t ON t.id = r."threadId"
      JOIN bots b ON b.id = r."botId"
      WHERE r."spaceId" = ${actor.spaceId}
        AND b."archivedAt" IS NULL
        AND r.trigger NOT IN (${Prisma.join([...ACTIVITY_HIDDEN_TRIGGERS])})
        AND r.status IN (${Prisma.join(statuses)})
      ORDER BY COALESCE('group:' || t."groupId", 'bot:' || r."botId"), r."completedAt" DESC, r."updatedAt" DESC, r.id DESC
    ) latest
    ORDER BY "completedAt" DESC, "updatedAt" DESC, id DESC
    LIMIT ${RECENT_LIMIT}`;
  return rows.map((row) => row.id);
}
