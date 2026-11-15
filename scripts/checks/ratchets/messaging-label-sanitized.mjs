export const message =
  "Wrap a chat-app display name, channel name or sender label in sanitizeMessagingLabel() before it reaches prompt text. The people in the chat set those labels, so they can carry newlines, quotes and brackets that close the prompt's framing and read as instructions.";

export const include = ["**/*.prompt.ts"];

const INTERPOLATION = /\$\{(?!\s*sanitizeMessagingLabel\()([^}]*)\}/g;
const LABEL = /\b(?:senderName|fromLabel|channelName)\b/;

/** Interpolations of a chat label that are not wrapped in sanitizeMessagingLabel(). */
export function count(text) {
  const hits = [];
  for (const match of text.matchAll(INTERPOLATION)) {
    if (!LABEL.test(match[1])) continue;
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const lineEnd = text.indexOf("\n", match.index);
    hits.push({
      line: text.slice(0, match.index).split("\n").length,
      text: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
    });
  }
  return hits;
}
