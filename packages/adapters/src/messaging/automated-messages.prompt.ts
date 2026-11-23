/**
 * Messages that Rakazo, or its model library, adds to a conversation in the user's role
 * are not from the user: screenshots moved out of tool results, nudges to continue,
 * finished background shell output, a helper's task. Models (local ones especially)
 * took them for the user replying, kept going instead of asking, and confused their
 * helpers with the user. Label them plainly.
 */
export const AUTOMATED_MESSAGE_LABEL = "[Automated message from Rakazo, not from the user]";

export function automated(text: string): string {
  return `${AUTOMATED_MESSAGE_LABEL} ${text}`;
}

/** Follows a kept reply in later history, so the model knows that reply is incomplete. */
export const PARTIAL_REPLY_NOTE = automated(
  "This reply was cut off by an error before it was finished.",
);

/** What pi-ai writes before screenshots it moves out of a tool result into a user message. */
export const TOOL_IMAGES_TEXT = "Attached image(s) from tool result:";
export const TOOL_IMAGES_LABEL = automated(
  "Screenshot(s) returned by your last tool call. The user has not replied.",
);
