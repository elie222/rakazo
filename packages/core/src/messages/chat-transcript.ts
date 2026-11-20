import type { MessageBlock, RoutineEventChange } from "@rakazo/contracts";
import { isRetiredImportSetup, isToolActivityBlock } from "../runs/tool-activity.js";
import { projectMessageReactions } from "./message-reactions.js";
import { channelMessageLine } from "./message-text.js";
import { foldPeerReplies } from "./message-visibility.js";

type TranscriptMessage = {
  id: string;
  runId?: string;
  role: string;
  replyToMessageId?: string | null;
  blocks: MessageBlock[];
  createdAt: string;
};

/** Markdown that only character escapes can make, the same in every CommonMark reader. */
const INLINE_SYNTAX = /[\\`*_[\]<>|~&#]/g;
/** What starts a list or rule only at the start of a line. */
const LINE_START_SYNTAX = /^(\s*)([+=-]|\d+[.)])/;

/**
 * Text the chat shows as typed, escaped so a Markdown reader shows it the same: no formatting,
 * headings or lists of its own, and each line break kept.
 */
function literal(text: string): string {
  const lines = text
    .split("\n")
    .map((line) =>
      line
        .replace(INLINE_SYNTAX, "\\$&")
        .replace(
          LINE_START_SYNTAX,
          (_, space: string, mark: string) => `${space}${mark.replace(/[+=.)-]/g, "\\$&")}`,
        ),
    );
  // A backslash at the end of a line is a hard break; a blank line stays a paragraph break.
  return lines
    .map((line, i) => (line.trim() && lines[i + 1]?.trim() ? `${line}\\` : line))
    .join("\n");
}

/** A name or title on one line, so it can never start a heading or speaker of its own. */
function oneLine(text: string): string {
  return literal(text.replace(/\s+/g, " ").trim());
}

/**
 * A block as the chat shows it, in words; empty for what the chat leaves out. What the chat renders
 * as Markdown (a bot's reply, progress, a question, a computer's note) stays Markdown; everything it
 * shows as typed (your own messages, labels, names) is escaped to read the same.
 */
function blockMarkdown(
  block: MessageBlock,
  role: string,
  routineEvent: (change: RoutineEventChange, name: string) => string,
): string {
  if (isToolActivityBlock(block) || isRetiredImportSetup(block)) return "";
  switch (block.kind) {
    case "text":
      return role === "user" ? literal(block.text) : block.text;
    case "progress":
    case "ask":
    case "computer":
      return block.text;
    case "meta":
    case "handoff":
      return literal(block.text);
    case "channel_message":
      return literal(channelMessageLine(block));
    case "image":
    case "file":
      return `Attachment: ${oneLine(block.name)}`;
    case "choice":
      if (block.answerId === "_dismissed") return "";
      return [
        literal(block.question),
        ...(block.subtitle ? [literal(block.subtitle)] : []),
        ...block.options.map(
          (option) =>
            `- ${oneLine(option.letter)}. ${oneLine(option.label)}${block.answerId === option.id ? " ✓" : ""}`,
        ),
      ].join("\n");
    case "card":
      return block.lines.map((line) => `- ${oneLine(line.k)} → ${oneLine(line.v)}`).join("\n");
    case "page":
    case "voice_call":
    case "cloud_agent":
      return oneLine(block.title);
    case "call_request":
      return literal(block.reason);
    case "subagent": {
      // The card shows the helper's result as Markdown under its name.
      const body = block.result ?? block.task;
      return [oneLine(block.name), body].filter(Boolean).join(": ");
    }
    case "routine_event":
      return oneLine(routineEvent(block.change, block.name));
    case "chart":
    case "child_bot":
    case "app_connect":
    case "mcp_approval":
    case "skill_draft":
      return oneLine(block.name);
    case "app":
      return oneLine(`${block.server}: ${block.tool}`);
    case "tool_question":
      return literal(block.question.source);
    case "import_setup":
      return block.items.map((item) => oneLine("name" in item ? item.name : item.title)).join("\n");
    // Left out: a delivery is the bot's prompt, tool steps are activity, and a peer receipt is a
    // chip in the chat whose bot-to-bot replies stay folded away.
    case "connect":
    case "delivery":
    case "steps":
    case "bot_message_sent":
    case "bot_message_received":
      return "";
  }
}

/** A readable copy of a chat as Markdown: who said what and when, in the order it was said. */
export function chatTranscriptMarkdown<T extends TranscriptMessage>(options: {
  title: string;
  messages: readonly T[];
  /** Who wrote the message, as the chat shows them. */
  speaker: (message: T) => string;
  /** When the message was sent, as the person reads dates. */
  time: (createdAt: string) => string;
  /** A routine's creation, change, switch or deletion, in the reader's words. */
  routineEvent: (change: RoutineEventChange, name: string) => string;
}): string {
  // Folded as the chat folds them: work a bot did for another bot stays under its receipt, and an
  // emoji-only reply shows under the message it reacts to.
  const { visibleMessages, reactions } = projectMessageReactions(
    foldPeerReplies(options.messages, { includePeerReceipts: true }).messages,
  );
  const entries = visibleMessages.flatMap((message) => {
    const body = message.blocks
      .map((block) => blockMarkdown(block, message.role, options.routineEvent).trim())
      .filter(Boolean)
      .join("\n");
    if (!body) return [];
    const counts = reactions.get(message.id);
    const reactionLine = counts
      ? `\n\n${[...counts].map(([emoji, count]) => (count > 1 ? `${emoji} ${count}` : emoji)).join(" ")}`
      : "";
    return [
      `**${oneLine(options.speaker(message))}** · ${options.time(message.createdAt)}\n\n${body}${reactionLine}`,
    ];
  });
  return `${[`# ${oneLine(options.title)}`, ...entries].join("\n\n---\n\n")}\n`;
}
