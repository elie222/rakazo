import type { MessageBlock, TopicSettledBy } from "@rakazo/contracts";
import { TOPIC_IDLE_SETTLE_DAYS } from "@rakazo/contracts";
import { plainTextFromMarkdown, truncatePlainText } from "./markdown-plain.js";
import { selectableMessageText } from "./message-text.js";

/** Longest title a topic shows; a longer first line is cut. */
const TOPIC_TITLE_MAX_LENGTH = 120;

/** A topic's title: the first line of the message it replies to, as plain text. */
export function topicTitle(root: { blocks: readonly MessageBlock[] }): string {
  const line =
    selectableMessageText(root)
      .split("\n")
      .find((part) => part.trim()) ?? "";
  return truncatePlainText(plainTextFromMarkdown(line), TOPIC_TITLE_MAX_LENGTH);
}

/**
 * Whether a topic counts as done for one viewer: marked done by them or the bot, or quiet for a
 * week after they read it. One they have not read stays open, so nothing settles unseen.
 * `quietSince` is the later of its last message and when it was last reopened.
 */
export function topicSettledBy(
  topic: { settledBy: string | null; unread: boolean; quietSince: Date },
  now: Date,
): TopicSettledBy | null {
  if (topic.settledBy === "user" || topic.settledBy === "bot") return topic.settledBy;
  const idleMs = TOPIC_IDLE_SETTLE_DAYS * 24 * 60 * 60 * 1000;
  return !topic.unread && now.getTime() - topic.quietSince.getTime() >= idleMs ? "idle" : null;
}
