export const message =
  "Do not join a timeout to a signal inline. Use deadlineSignal(ms, parent) from @rakazo/core.";

export const include = [
  "{packages/{adapters,core,db,auth,memory,logging},apps/{api,worker},infra/sandboxes/supervisor,infra/updater}/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
];

export const exclude = [
  "**/*.{test,spec}.*",
  "**/*{.,-}test-support.*",
  "**/testing/**",
  "packages/core/src/primitives/{async,retry,retry-policy}.ts",
];

const JOIN = /\b(?:AbortSignal\.any|anySignal)\(/g;
const TIMEOUT = "AbortSignal.timeout(";

/** A signal join whose own arguments, on however many lines, create the timeout. */
export function count(text) {
  if (!text.includes(TIMEOUT)) return [];
  const hits = [];
  for (const match of text.matchAll(JOIN)) {
    const open = match.index + match[0].length;
    if (!text.slice(open, closingParen(text, open)).includes(TIMEOUT)) continue;
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const lineEnd = text.indexOf("\n", match.index);
    hits.push({
      line: text.slice(0, match.index).split("\n").length,
      text: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
    });
  }
  return hits;
}

function closingParen(text, open) {
  let depth = 1;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    else if (text[at] === ")" && --depth === 0) return at;
  }
  return text.length;
}
