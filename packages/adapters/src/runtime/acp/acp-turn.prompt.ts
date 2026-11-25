/** How a message the bot itself wrote is labeled when the chat is replayed to a new session. */
export const OWN_SPEAKER = "You";
/** How a person's message is labeled when nothing names them. */
export const PERSON_SPEAKER = "User";

export function historyLine(speaker: string, content: string): string {
  return `[${speaker}]: ${content}`;
}

/**
 * Opens the chat messages the CLI's session has not seen, placed before the new message, each
 * followed by its images. A new session gets the conversation so far; a continued one gets only
 * what others wrote since the bot last replied.
 */
export function conversationOpen(fresh: boolean): string {
  return fresh
    ? "<conversation_history>\nThe conversation before this message. Tool calls and results from it are not shown; use your tools again if you need them."
    : "<new_messages>\nMessages written since your last reply.";
}

export function conversationClose(fresh: boolean): string {
  return fresh ? "</conversation_history>" : "</new_messages>";
}

/** Where an image came from, as the list of a message's images names it. */
export function imageSource(line: string | undefined): string {
  return line
    ? `From ${line.length > 80 ? `${line.slice(0, 80)}…` : line}`
    : "Attached to this message";
}

/**
 * Names each image a message carries, in order, so the model can tell an earlier message's image
 * from the new one's even where the CLI shows all images together.
 */
export function imageList(sources: readonly string[]): string {
  return `<images>\nThe images in this message, in order:\n${sources.map((source, index) => `${index + 1}. ${source}`).join("\n")}\n</images>`;
}

/** The tool result for a call to a tool this turn does not have. */
export function unknownToolText(name: string): string {
  return `${name} is not one of this turn's tools.`;
}
