import * as z from "zod";
import { Id } from "../ids.js";
import { MessageBlock, MessageRole } from "./message-blocks.js";

/** The person who wrote a user message, when known. */
export const MessageAuthorSchema = z.object({ id: Id, name: z.string() });
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>;

export const ReplyPreviewSchema = z.object({
  role: MessageRole,
  /** The parent is a page card. */
  page: z.literal(true).optional(),
  botId: Id.optional(),
  author: MessageAuthorSchema.optional(),
  text: z.string(),
  attachment: z
    .object({
      kind: z.enum(["image", "file"]),
      artifactId: Id,
      mimeType: z.string(),
      name: z.string(),
    })
    .optional(),
});
export type ReplyPreview = z.infer<typeof ReplyPreviewSchema>;

export const ThreadMessageSchema = z.object({
  id: Id,
  threadId: Id,
  seq: z.number().int().nonnegative(),
  role: MessageRole,
  blocks: z.array(MessageBlock),
  botId: Id.optional(),
  author: MessageAuthorSchema.optional(),
  replyToMessageId: Id.optional(),
  replyQuote: z.string().optional(),
  replyPreview: ReplyPreviewSchema.nullable().optional(),
  runId: Id.optional(),
  /** Set when the message was sent from a live voice call; groups one call's transcript. */
  callId: z.string().optional(),
  createdAt: z.string(),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export function canReactToThreadMessage(message: Pick<ThreadMessage, "id" | "blocks">): boolean {
  return (
    !message.id.startsWith("progress:") &&
    !message.id.startsWith("subagent:") &&
    !message.blocks.some((block) => block.kind === "channel_message")
  );
}
