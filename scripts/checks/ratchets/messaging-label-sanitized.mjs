export const message =
  "Wrap a chat-app display name, channel name or sender label in sanitizeMessagingLabel() before it reaches prompt text. The people in the chat set those labels, so they can carry newlines, quotes and brackets that close the prompt's framing and read as instructions.";

export const include = ["**/*.prompt.ts", "packages/adapters/src/messaging-delivery.ts"];

const LABEL = /\b(?:senderName|fromLabel|channelName|channel\.name)\b/;
const SANITIZED_CALL = "sanitizeMessagingLabel(";
const QUOTES = new Set(['"', "'", "`"]);

/** The index of the `}` that closes the `${` at `start`, or -1 when the file is malformed. */
function interpolationEnd(text, start) {
  let depth = 1;
  let quote = "";
  for (let index = start + 2; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (QUOTES.has(character)) quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

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
  let start = text.indexOf("${");
  while (start !== -1) {
    const end = interpolationEnd(text, start);
    if (end === -1) break;
    const body = text.slice(start + 2, end);
    const next = end + 1;
    if (LABEL.test(unsanitized(body))) {
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = text.indexOf("\n", start);
      hits.push({
        line: text.slice(0, start).split("\n").length,
        text: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
      });
    }
    start = text.indexOf("${", next);
  }
  return hits;
}
