import { randomUUID } from "node:crypto";
import type { DraftBlock } from "@rakazo/contracts";
import {
  DRAFT_BODY_MAX_LENGTH,
  DRAFT_LABEL_MAX_LENGTH,
  DRAFT_SUBJECT_MAX_LENGTH,
  DRAFT_TO_MAX_LENGTH,
} from "@rakazo/contracts";
import {
  appendEventInTransaction,
  changeMessageBlocks,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { argumentGiven } from "../../bots/update-bot-patch.js";
import type { RunContext } from "../assembly/run-context.js";
import { publishMessage, redactBlocks, runLeaseFor } from "../assembly/run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

/** A draft's card is found again by this key, so a revision rewrites it in place. */
export function draftClientNonce(draftId: string): string {
  return `draft:${draftId}`;
}

type DraftFields = Partial<Pick<DraftBlock, "label" | "to" | "subject" | "body">>;

const FIELD_LIMITS = [
  ["label", DRAFT_LABEL_MAX_LENGTH],
  ["to", DRAFT_TO_MAX_LENGTH],
  ["subject", DRAFT_SUBJECT_MAX_LENGTH],
  ["body", DRAFT_BODY_MAX_LENGTH],
] as const;

function draftFields(args: Record<string, unknown>): { fields: DraftFields } | { error: string } {
  const fields: DraftFields = {};
  for (const [name, max] of FIELD_LIMITS) {
    const value = args[name];
    // A blank recipient or subject is how a revision removes one.
    if (
      (name === "to" || name === "subject") &&
      (value === null || (typeof value === "string" && !value.trim()))
    ) {
      fields[name] = "";
      continue;
    }
    if (!argumentGiven(value)) continue;
    if (typeof value !== "string") return { error: `${name} must be text.` };
    const text = value.trim();
    if (text.length > max) return { error: `${name} must be at most ${max} characters.` };
    fields[name] = text;
  }
  return { fields };
}

function redactDraft(block: DraftBlock, secrets: string[]): DraftBlock {
  return redactBlocks([block], secrets)[0] as DraftBlock;
}

async function writeDraft(ctx: RunContext, call: ToolCall) {
  const read = draftFields(call.args);
  if ("error" in read) return { error: read.error };
  const { fields } = read;
  if (!fields.body) return { error: "A draft needs a body." };
  if (argumentGiven(call.args.draftId)) {
    return reviseDraft(ctx, String(call.args.draftId), { ...fields, body: fields.body });
  }
  if (!fields.label) return { error: "A new draft needs a label." };
  const draftId = randomUUID();
  const block = redactDraft(
    {
      kind: "draft",
      draftId,
      label: fields.label,
      ...(fields.to ? { to: fields.to } : {}),
      ...(fields.subject ? { subject: fields.subject } : {}),
      body: fields.body,
      version: 1,
    },
    ctx.secrets,
  );
  await publishMessage(ctx.deps, ctx.run, "bot", [block], undefined, draftClientNonce(draftId));
  return { draftId, version: 1, shown: "The user sees the draft as a card in the chat." };
}

async function reviseDraft(
  ctx: RunContext,
  draftId: string,
  fields: DraftFields & { body: string },
) {
  const { deps, run } = ctx;
  // Like publishMessage: a deadlock or serialization victim commits nothing, so try again.
  const saved = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      const message = await tx.message.findUnique({
        where: {
          threadId_clientNonce: { threadId: run.threadId, clientNonce: draftClientNonce(draftId) },
        },
        select: { id: true, blocks: true, botId: true },
      });
      if (!message || message.botId !== run.botId) return null;
      const current = storedMessageBlocks(message).find(
        (block): block is DraftBlock => block.kind === "draft" && block.draftId === draftId,
      );
      if (!current) return null;
      const { to, subject, ...rest } = { ...current, ...fields };
      const next = redactDraft(
        {
          ...rest,
          ...(to ? { to } : {}),
          ...(subject ? { subject } : {}),
          version: current.version + 1,
        },
        ctx.secrets,
      );
      const changed = changeMessageBlocks(message, (block) => (block === current ? next : block));
      if (!changed) return null;
      await tx.message.update({ where: { id: message.id }, data: { blocks: changed.stored } });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        type: "thread.message.updated",
        payload: { messageId: message.id, role: "bot", blocks: changed.blocks },
        lease: runLeaseFor(deps, run.id),
      });
      return { version: next.version, seq: event.seq };
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  if (!saved) {
    return {
      error: "No draft of yours with that draftId is in this chat. Omit draftId to start one.",
    };
  }
  await bestEffort("draft revision notification", deps.events.notify(run.threadId, saved.seq));
  return {
    draftId,
    version: saved.version,
    shown: "The draft's card in the chat now shows this version.",
  };
}

export const draftTools: ToolHandlers = {
  async write_draft(ctx, call) {
    return call.finish(await writeDraft(ctx, call));
  },
};
