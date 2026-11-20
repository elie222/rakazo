import * as z from "zod";
import { ComputerStatusSchema } from "../computers/computer.js";
import { Id } from "../ids.js";
import { RunSchema } from "../runs/runs.js";
import { GroupMemberSchema } from "../spaces/groups.js";
import { ThreadMessageSchema } from "./thread-message.js";

/** A run alert the server also pushes to phones, already filtered by the chat's mute settings. */
export const ChatAlertSchema = z.object({
  kind: z.enum(["completion", "failure", "help", "takeover"]),
  title: z.string(),
  body: z.string(),
  spaceId: Id,
  botId: Id,
  threadId: Id,
  groupId: Id.optional(),
  /** Set when the run was in a topic of the bot's chat; equals threadId. */
  topicId: Id.optional(),
});
export type ChatAlert = z.infer<typeof ChatAlertSchema>;

/** Selected-text excerpt carried by a reply; capped so a quote stays a quote. */
export const REPLY_QUOTE_MAX_LENGTH = 2_000;

/**
 * One chat message's text. Far above anything the composer produces, but bounded so one
 * oversized send cannot dominate persistence and every viewer's markdown processing.
 */
export const THREAD_MESSAGE_TEXT_MAX_LENGTH = 100_000;

/** Cap an excerpt at the quote limit without splitting a surrogate pair. */
export function truncateReplyQuote(value: string): string {
  const truncated = value.slice(0, REPLY_QUOTE_MAX_LENGTH);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

export const ThreadMessagePageSchema = z.object({
  threadId: Id,
  messages: z.array(ThreadMessageSchema),
  olderCursor: z.number().int().nonnegative().nullable(),
  coveredThroughSeq: z.number().int().nonnegative().optional(),
});
export type ThreadMessagePage = z.infer<typeof ThreadMessagePageSchema>;

export const ThreadSnapshotSchema = z.object({
  threadId: Id,
  cursor: z.number().int().min(-1),
  messages: z.array(ThreadMessageSchema),
  olderCursor: z.number().int().nonnegative().nullable(),
  botId: Id.optional(),
  groupId: Id.optional(),
  groupName: z.string().optional(),
  members: z.array(GroupMemberSchema).optional(),
  run: RunSchema.nullable(),
  activeRuns: z.array(RunSchema).optional(),
  computer: ComputerStatusSchema.optional(),
  /** A topic's snapshot carries the message it replies to, which lives in the bot's chat. */
  topicRoot: ThreadMessageSchema.optional(),
});
export type ThreadSnapshot = z.infer<typeof ThreadSnapshotSchema>;
