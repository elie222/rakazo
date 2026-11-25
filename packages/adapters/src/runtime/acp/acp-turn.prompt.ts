/** How a message the bot itself wrote is labeled when the chat is replayed to a new session. */
export const OWN_SPEAKER = "You";
/** How a person's message is labeled when nothing names them. */
export const PERSON_SPEAKER = "User";

export function historyLine(speaker: string, content: string): string {
  return `[${speaker}]: ${content}`;
}

/**
 * Chat messages the CLI's session has not seen, placed before the new message. A new session gets
 * the conversation so far; a continued one gets only what others wrote since the bot last replied.
 */
export function conversationBlock(lines: readonly string[], fresh: boolean): string {
  if (!lines.length) return "";
  return fresh
    ? `<conversation_history>\nThe conversation before this message. Tool calls and results from it are not shown; use your tools again if you need them.\n\n${lines.join("\n\n")}\n</conversation_history>`
    : `<new_messages>\nMessages written since your last reply.\n\n${lines.join("\n\n")}\n</new_messages>`;
}

/** The tool result for a call to a tool this turn does not have. */
export function unknownToolText(name: string): string {
  return `${name} is not one of this turn's tools.`;
}
