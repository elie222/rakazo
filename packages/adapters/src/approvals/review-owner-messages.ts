import { truncateReviewText } from "./auto-review.prompt.js";

/** How many of the owner's earlier messages Auto Review sees, and how much of each. */
export const REVIEW_OWNER_MESSAGES = 3;
const MAX_OWNER_MESSAGE_CHARS = 300;

/** The owner's last few earlier messages, oldest first, each capped. */
export function reviewOwnerMessages(messages: readonly string[]): string[] {
  return messages
    .map((message) => message.trim())
    .filter(Boolean)
    .slice(-REVIEW_OWNER_MESSAGES)
    .map((message) => truncateReviewText(message, MAX_OWNER_MESSAGE_CHARS));
}
