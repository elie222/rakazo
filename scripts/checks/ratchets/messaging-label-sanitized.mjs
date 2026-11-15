export const message =
  "Wrap a chat-app display name, channel name or sender label in sanitizeMessagingLabel() before it reaches prompt text. The people in the chat set those labels, so they can carry newlines, quotes and brackets that close the prompt's framing and read as instructions.";

export const include = ["**/*.prompt.ts", "packages/adapters/src/messaging-delivery.ts"];

const INTERPOLATION = /\$\{([^}]*)\}/g;
const LABEL = /\b(?:senderName|fromLabel|channelName|channel\.name)\b/;
const SANITIZED_CALL = "sanitizeMessagingLabel(";

/** The expression with every sanitizeMessagingLabel(...) call removed, so what remains is raw. */
function unsanitized(body) {
  let rest = "";
  let index = 0;
  while (index < body.length) {
    const at = body.indexOf(SANITIZED_CALL, index);
    if (at === -1) {
      rest += body.slice(index);
      break;
    }
    rest += body.slice(index, at);
    let depth = 0;
    let end = at + SANITIZED_CALL.length - 1;
    for (; end < body.length; end += 1) {
      const character = body[end];
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    index = end;
  }
  return rest;
}

/** Interpolations of a chat label that are not wrapped in sanitizeMessagingLabel(). */
export function count(text) {
  const hits = [];
  for (const match of text.matchAll(INTERPOLATION)) {
    if (!LABEL.test(unsanitized(match[1]))) continue;
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const lineEnd = text.indexOf("\n", match.index);
    hits.push({
      line: text.slice(0, match.index).split("\n").length,
      text: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
    });
  }
  return hits;
}
