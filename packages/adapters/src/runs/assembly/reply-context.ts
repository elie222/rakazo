import type { MessageBlock, ToolHistory } from "@rakazo/contracts";
import { ToolHistorySchema, truncateReplyQuote } from "@rakazo/contracts";
import type { AgentHistorySegment } from "@rakazo/core";
import {
  blocksToAgentHistorySegments,
  blocksToAgentHistoryText,
  messageReaction,
  withToolHistory,
} from "@rakazo/core";
import { isPageCardMessage } from "@rakazo/core/message-quote";
import type { PrismaClient } from "@rakazo/db";
import { storedMessageBlocks } from "@rakazo/db";
import { replyTargetNote } from "../../runtime/context/history-replay.prompt.js";

type QuotedMessage = {
  id: string;
  threadId: string;
  role: string;
  botId?: string | null;
  blocks: unknown;
};
type ReplyMessage = QuotedMessage & {
  replyToMessageId?: string | null;
  replyQuote?: string | null;
  replyTo?: QuotedMessage | null;
};

function messageBlocks(message: QuotedMessage): MessageBlock[] {
  return storedMessageBlocks(message);
}

function replyContext(
  source: ReplyMessage,
  threadId: string,
  redact?: (text: string) => string,
): string | undefined {
  const target = source.replyTo;
  if (!target || target.threadId !== threadId) return undefined;
  const emoji = messageReaction({ ...source, blocks: messageBlocks(source) });
  // A selected-text excerpt narrows the reply to just that span; reactions stay
  // on the whole-message path because a reaction always targets the message.
  // A page card is always read whole, so the bot gets the page's id, not just its title.
  const wholePage = isPageCardMessage(messageBlocks(target));
  const rawExcerpt =
    !emoji && !wholePage && typeof source.replyQuote === "string"
      ? source.replyQuote.trim()
      : undefined;
  const excerpt = rawExcerpt ? (redact ? redact(rawExcerpt) : rawExcerpt) : undefined;
  const targetPayload = excerpt
    ? { quotedText: truncateReplyQuote(excerpt) }
    : (() => {
        const content = blocksToAgentHistoryText(messageBlocks(target), redact);
        return {
          content: content.slice(0, 20_000),
          ...(content.length > 20_000 ? { truncated: true } : {}),
        };
      })();
  const quote = JSON.stringify({
    messageId: target.id,
    role: target.role,
    botId: target.botId ?? undefined,
    ...targetPayload,
  })
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return replyTargetNote(emoji, quote);
}

export function messageToAgentHistoryText(
  message: ReplyMessage,
  redact?: (text: string) => string,
): string {
  return [
    replyContext(message, message.threadId, redact),
    blocksToAgentHistoryText(messageBlocks(message), redact),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A message split at its tool steps, as messageToAgentHistoryText reads it; none without steps. */
export function messageToAgentHistorySegments(
  message: ReplyMessage & { toolHistory?: string | null },
  redact?: (text: string) => string,
): AgentHistorySegment[] | undefined {
  const segments = blocksToAgentHistorySegments(
    withToolHistory(messageBlocks(message), parsedToolHistory(message.toolHistory)),
    redact,
  );
  if (!segments.some((segment) => "steps" in segment)) return undefined;
  const context = replyContext(message, message.threadId, redact);
  return context ? [{ text: context }, ...segments] : segments;
}

/** The runtime's record of the turn a reply ended, when it kept one. */
export function messageTranscript(message: { toolHistory?: string | null }): string | undefined {
  return parsedToolHistory(message.toolHistory)?.transcript;
}

/** A message's stored tool history, or none when it has none or it cannot be read. */
function parsedToolHistory(stored: string | null | undefined): ToolHistory | undefined {
  if (!stored) return undefined;
  try {
    const parsed = ToolHistorySchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Fetch the explicit target even when it has fallen outside the history window. */
export async function loadReplyContext(
  prisma: PrismaClient,
  threadId: string,
  sourceMessageId: string | null | undefined,
  redact?: (text: string) => string,
): Promise<string | undefined> {
  if (!sourceMessageId) return undefined;
  const selection = { id: true, threadId: true, role: true, botId: true, blocks: true } as const;
  const source = await prisma.message.findFirst({
    where: { id: sourceMessageId, threadId },
    select: {
      ...selection,
      replyToMessageId: true,
      replyQuote: true,
      replyTo: { select: selection },
    },
  });
  return source ? replyContext(source, threadId, redact) : undefined;
}
