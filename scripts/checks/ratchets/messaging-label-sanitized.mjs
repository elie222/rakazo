export const message =
  "Wrap a chat-app display name, channel name or sender label in sanitizeMessagingLabel() before it reaches prompt text. The people in the chat set those labels, so they can carry newlines, quotes and brackets that close the prompt's framing and read as instructions.";

export const include = [
  "**/*.prompt.ts",
  "packages/adapters/src/messaging/messaging-delivery.ts",
  "apps/api/src/messaging/messaging-inbound.ts",
];

const LABEL = /\b(?:senderName|fromLabel|channelName)\b|\bchannel\s*\.\s*name\b/;
const SANITIZED_NAME = "sanitizeMessagingLabel";

/** The `(` after the name at `index` when only whitespace separates them, or -1. */
function callOpenAt(text, index) {
  let cursor = index + SANITIZED_NAME.length;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return text[cursor] === "(" ? cursor : -1;
}

/** The index of the quote that closes the string at `index`, or -1 when the file is malformed. */
function quoteEnd(text, index) {
  const quote = text[index];
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\\") cursor += 1;
    else if (text[cursor] === quote) return cursor;
  }
  return -1;
}

/** The index of the backtick that closes the template at `index`, or -1 when it never closes. */
function templateEnd(text, index) {
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (character === "\\") cursor += 1;
    else if (character === "`") return cursor;
    else if (character === "$" && text[cursor + 1] === "{") {
      const end = interpolationEnd(text, cursor);
      if (end === -1) return -1;
      cursor = end;
    }
  }
  return -1;
}

/** The index of the `}` that closes the `${` at `start`, or -1 when the file is malformed. */
function interpolationEnd(text, start) {
  let depth = 1;
  for (let index = start + 2; index < text.length; index += 1) {
    const character = text[index];
    if (character === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      if (newline === -1) return -1;
      index = newline;
    } else if (character === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      if (close === -1) return -1;
      index = close + 1;
    } else if (character === '"' || character === "'") {
      const end = quoteEnd(text, index);
      if (end === -1) return -1;
      index = end;
    } else if (character === "`") {
      const end = templateEnd(text, index);
      if (end === -1) return -1;
      index = end;
    } else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Every `${...}` that a template literal in the file actually evaluates. */
function* interpolations(text) {
  let quote = "";
  let template = false;
  let comment = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (comment === "line") {
      if (character === "\n") comment = "";
      continue;
    }
    if (comment === "block") {
      if (character === "*" && text[index + 1] === "/") {
        comment = "";
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (template) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === "`") {
        template = false;
        continue;
      }
      if (character === "$" && text[index + 1] === "{") {
        const end = interpolationEnd(text, index);
        if (end === -1) return;
        yield { start: index, body: text.slice(index + 2, end) };
        index = end;
      }
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      comment = "line";
      index += 1;
    } else if (character === "/" && text[index + 1] === "*") {
      comment = "block";
      index += 1;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "`") template = true;
  }
}

/** The index just past the `)` that closes the `(` at `open`, or -1 when it never closes. */
function callEnd(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      if (newline === -1) return -1;
      index = newline;
    } else if (character === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      if (close === -1) return -1;
      index = close + 1;
    } else if (character === '"' || character === "'") {
      const end = quoteEnd(text, index);
      if (end === -1) return -1;
      index = end;
    } else if (character === "`") {
      const end = templateEnd(text, index);
      if (end === -1) return -1;
      index = end;
    } else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** The unsanitized part of each interpolation inside the template literal at [from, to). */
function rawInsideTemplate(text, from, to) {
  let out = "";
  for (let index = from; index < to; index += 1) {
    const character = text[index];
    if (character === "\\") index += 1;
    else if (character === "$" && text[index + 1] === "{") {
      const end = interpolationEnd(text, index);
      if (end === -1) return out;
      out += unsanitized(text.slice(index + 2, end));
      index = end;
    }
  }
  return out;
}

/** The expression with every standalone sanitizeMessagingLabel(...) call removed, so what remains is raw. */
function unsanitized(body) {
  let rest = "";
  let index = 0;
  while (index < body.length) {
    const character = body[index];
    if (character === "/" && body[index + 1] === "/") {
      const end = body.indexOf("\n", index);
      index = end === -1 ? body.length : end;
      continue;
    }
    if (character === "/" && body[index + 1] === "*") {
      const end = body.indexOf("*/", index + 2);
      index = end === -1 ? body.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const end = quoteEnd(body, index);
      if (end === -1) return `${rest}${body.slice(index)}`;
      // A quoted string is a value, so its words are not label names.
      rest += " ";
      index = end + 1;
      continue;
    }
    if (character === "`") {
      const end = templateEnd(body, index);
      if (end === -1) return `${rest}${body.slice(index)}`;
      // Only a template's interpolations are evaluated; its text is a string.
      rest += rawInsideTemplate(body, index + 1, end);
      index = end + 1;
      continue;
    }
    const at = body.indexOf(SANITIZED_NAME, index);
    if (at === -1) {
      rest += body.slice(index);
      break;
    }
    const open = callOpenAt(body, at);
    const end = open === -1 ? -1 : callEnd(body, open);
    // A name that merely ends in the call, like `mySanitizeMessagingLabel(`, is not the sanitizer.
    const standalone = at === 0 || !/[A-Za-z0-9_$.]/.test(body[at - 1]);
    if (!standalone || end === -1) {
      rest += body.slice(index, at + SANITIZED_NAME.length);
      index = at + SANITIZED_NAME.length;
      continue;
    }
    rest += body.slice(index, at);
    index = end;
  }
  return rest;
}

/** Interpolations of a chat label that are not wrapped in sanitizeMessagingLabel(). */
export function count(text) {
  const hits = [];
  for (const { start, body } of interpolations(text)) {
    if (!LABEL.test(unsanitized(body))) continue;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = text.indexOf("\n", start);
    hits.push({
      line: text.slice(0, start).split("\n").length,
      text: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
    });
  }
  return hits;
}
