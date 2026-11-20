import type { MessageBlock } from "@rakazo/contracts";
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

/** A block as the chat shows it, in words; empty for what the chat leaves out. */
function blockMarkdown(block: MessageBlock): string {
  if (isToolActivityBlock(block) || isRetiredImportSetup(block)) return "";
  switch (block.kind) {
    case "text":
    case "progress":
    case "ask":
    case "meta":
    case "computer":
    case "handoff":
      return block.text;
    case "channel_message":
      return channelMessageLine(block);
    case "image":
    case "file":
      return `Attachment: ${block.name}`;
    case "choice":
      if (block.answerId === "_dismissed") return "";
      return [
        block.question,
        ...(block.subtitle ? [block.subtitle] : []),
        ...block.options.map(
          (option) =>
            `- ${option.letter}. ${option.label}${block.answerId === option.id ? " ✓" : ""}`,
        ),
      ].join("\n");
    case "card":
      return block.lines.map((line) => `- ${line.k} → ${line.v}`).join("\n");
    case "page":
    case "voice_call":
    case "cloud_agent":
      return block.title;
    case "call_request":
      return block.reason;
    case "subagent":
      return [block.name, block.result ?? block.task].filter(Boolean).join(": ");
    case "chart":
    case "child_bot":
    case "app_connect":
    case "mcp_approval":
    case "skill_draft":
    case "routine_event":
      return block.name;
    case "app":
      return `${block.server}: ${block.tool}`;
    case "tool_question":
      return block.question.source;
    case "import_setup":
      return block.items.map((item) => ("name" in item ? item.name : item.title)).join("\n");
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
}): string {
  // Folded as the chat folds them: work a bot did for another bot stays under its receipt, and an
  // emoji-only reply shows under the message it reacts to.
  const { visibleMessages, reactions } = projectMessageReactions(
    foldPeerReplies(options.messages, { includePeerReceipts: true }).messages,
  );
  const entries = visibleMessages.flatMap((message) => {
    const body = message.blocks
      .map((block) => blockMarkdown(block).trim())
      .filter(Boolean)
      .join("\n");
    if (!body) return [];
    const counts = reactions.get(message.id);
    const reactionLine = counts
      ? `\n\n${[...counts].map(([emoji, count]) => (count > 1 ? `${emoji} ${count}` : emoji)).join(" ")}`
      : "";
    return [
      `**${options.speaker(message)}** · ${options.time(message.createdAt)}\n\n${body}${reactionLine}`,
    ];
  });
  return `${[`# ${options.title}`, ...entries].join("\n\n---\n\n")}\n`;
}
