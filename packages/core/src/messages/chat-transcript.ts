import type { MessageBlock } from "@rakazo/contracts";
import { selectableMessageText } from "./message-text.js";
import { userVisibleMessages } from "./message-visibility.js";

type TranscriptMessage = {
  id: string;
  runId?: string;
  role?: string;
  replyToMessageId?: string | null;
  blocks: readonly MessageBlock[];
  createdAt: string;
};

/** A readable copy of a chat as Markdown: who said what and when, in the order it was said. */
export function chatTranscriptMarkdown<T extends TranscriptMessage>(options: {
  title: string;
  messages: readonly T[];
  /** Who wrote the message, as the chat shows them. */
  speaker: (message: T) => string;
  /** When the message was sent, as the person reads dates. */
  time: (createdAt: string) => string;
}): string {
  const entries = userVisibleMessages(options.messages).flatMap((message) => {
    const attachments = message.blocks.flatMap((block) =>
      block.kind === "image" || block.kind === "file" ? [`Attachment: ${block.name}`] : [],
    );
    const body = [selectableMessageText(message).trim(), ...attachments].filter(Boolean).join("\n");
    if (!body) return [];
    return [`**${options.speaker(message)}** · ${options.time(message.createdAt)}\n\n${body}`];
  });
  return `${[`# ${options.title}`, ...entries].join("\n\n---\n\n")}\n`;
}
