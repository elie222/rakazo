export const message =
  "Do not translate a caught error into an ORPCError by hand. Throw a domain error that carries its client answer (extend ClientError from @rakazo/core, or add the class to apps/api/src/rpc-errors.ts) and let it propagate: handleRpcError translates it once, and anything else stays a logged server error.";

export const include = ["apps/api/src/**/*.ts"];

export const exclude = ["**/*.{test,spec}.*", "**/*{.,-}test-support.*", "**/testing/**"];

// White space and comments may sit between `catch`, its binding and its block.
const GAP = "(?:\\s|\\/\\*[^]*?\\*\\/|\\/\\/[^\\n]*)*";
const CATCH_CLAUSE = new RegExp(`catch${GAP}(?:\\([^)]*\\)${GAP})?\\{`, "y");
// With or without a type argument: `.catch<unknown>(`.
const CATCH_CALLBACK = /\.catch\s*(?:<[^>()]*>\s*)?\(/y;
const THROWN = /new\s+ORPCError\b/y;
// `>` is the end of an arrow: `(s) => /x/.test(s)`.
const REGEX_MAY_FOLLOW = /(?:^|[(,=:[!&|?{};>]|\breturn)\s*$/;
const WORD = /[\w$]/;

/**
 * Every `new ORPCError` written lexically inside a `catch` block or a `.catch(...)` callback,
 * including inside a function nested in one. A translator the handler only calls is not seen.
 */
export function count(text) {
  const hits = [];
  // Open brackets: "{" and "(" plain, "catch" for a handler's block or callback, "`" for a
  // template literal whose text runs until the matching backtick.
  const open = [];
  let handlers = 0;
  const push = (kind) => {
    open.push(kind);
    if (kind === "catch") handlers += 1;
  };
  const pop = () => {
    if (open.pop() === "catch") handlers -= 1;
  };
  const at = (pattern, index) => {
    pattern.lastIndex = index;
    return pattern.exec(text);
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (open.at(-1) === "`") {
      if (char === "\\") i += 1;
      else if (char === "`") pop();
      else if (char === "$" && text[i + 1] === "{") {
        push("{");
        i += 1;
      }
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      i = endOr(text, text.indexOf("\n", i));
    } else if (char === "/" && text[i + 1] === "*") {
      i = endOr(text, text.indexOf("*/", i + 2)) + 1;
    } else if (char === "/" && REGEX_MAY_FOLLOW.test(text.slice(Math.max(0, i - 40), i))) {
      i = closingQuote(text, i);
    } else if (char === '"' || char === "'") {
      i = closingQuote(text, i);
    } else if (char === "`") {
      push("`");
    } else if (char === "{" || char === "(") {
      push(char);
    } else if (char === "}" || char === ")") {
      pop();
    } else if (char === "." && at(CATCH_CALLBACK, i)) {
      i = CATCH_CALLBACK.lastIndex - 1;
      push("catch");
    } else if (WORD.test(char) && !WORD.test(text[i - 1] ?? "")) {
      if (at(CATCH_CLAUSE, i)) {
        i = CATCH_CLAUSE.lastIndex - 1;
        push("catch");
      } else if (handlers > 0 && at(THROWN, i)) {
        hits.push(hitAt(text, i));
      }
    }
  }
  return hits;
}

/** The index of the quote or slash that closes the literal opened at `start`. */
function closingQuote(text, start) {
  const quote = text[start];
  let inClass = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") i += 1;
    else if (char === "\n") return i;
    else if (quote === "/" && char === "[") inClass = true;
    else if (quote === "/" && char === "]") inClass = false;
    else if (char === quote && !inClass) return i;
  }
  return text.length;
}

function endOr(text, index) {
  return index === -1 ? text.length : index;
}

function hitAt(text, start) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", start);
  return {
    line: text.slice(0, start).split("\n").length,
    text: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
  };
}
