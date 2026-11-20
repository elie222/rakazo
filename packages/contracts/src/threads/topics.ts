import * as z from "zod";
import { Id } from "../ids.js";

/**
 * A topic is a thread of replies to one message in a bot chat. It is open until someone marks it
 * done, the bot settles it, or it goes quiet after its viewer has read it.
 */
export const TOPIC_IDLE_SETTLE_DAYS = 7;

export const TopicSettledBy = z.enum(["user", "bot", "idle"]);
export type TopicSettledBy = z.infer<typeof TopicSettledBy>;

export const TopicSummarySchema = z.object({
  id: Id,
  rootMessageId: Id,
  /** The first line of the message it replies to. */
  title: z.string(),
  /** Opened by the bot as something to act on, so it is listed before anyone replies. */
  item: z.boolean(),
  replyCount: z.number().int().nonnegative(),
  lastActivityAt: z.iso.datetime(),
  unread: z.boolean(),
  /** Null while open. */
  settledBy: TopicSettledBy.nullable(),
});
export type TopicSummary = z.infer<typeof TopicSummarySchema>;

export const TopicListInput = z.object({ botId: Id });
export const TopicOpenInput = z.object({ botId: Id, messageId: Id });
export const TopicSettleInput = z.object({ botId: Id, topicId: Id, done: z.boolean() });
