export const message =
  "Do not hand-write an attempt loop or a backoff formula. Use retry(operation, { attempts, delayMs, retryable, signal }) from @rakazo/core; pass delayMs to reproduce a specific schedule. If the loop waits for a condition instead of retrying a failure, use pollUntil.";

export const include = [
  "{packages/{adapters,core,db,auth,memory,logging},apps/{api,worker},infra/sandboxes/supervisor,infra/updater}/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
];

export const exclude = [
  "**/*.{test,spec}.*",
  "**/*{.,-}test-support.*",
  "**/testing/**",
  "packages/core/src/primitives/{async,retry,retry-policy}.ts",
];

// A counting loop whose header names what it counts: attempts, retries or tries.
const COUNTING_LOOP = /^([ \t]*)for \((?:\n[ \t]*)?let ([^\n]*)$/gm;
const ATTEMPT_NAME = /attempt|retr(?:y|ies)|\btries\b/i;
// Doubling written straight into a wait. A formula handed to retry's delayMs is not a wait.
const BACKOFF_WAIT =
  /\b(?:await\s+(?:[\w$]+\.)*\w*(?:sleep|delay)|setTimeout)\([^;]{0,200}?(?:\b2 \*\* |Math\.pow\(\s*2\s*,)/gi;

export function count(text) {
  const starts = [];
  for (const match of text.matchAll(COUNTING_LOOP)) {
    const [header, indent, counter] = match;
    if (!ATTEMPT_NAME.test(counter)) continue;
    // Formatted code closes a block on a line that starts at the indentation of its opener.
    const close = text.indexOf(`\n${indent}}`, match.index + header.length);
    const body = text.slice(match.index + header.length, close === -1 ? undefined : close);
    // Trying an operation again means awaiting it; a loop that awaits nothing only recomputes.
    if (/\bawait\b/.test(body)) starts.push(match.index + indent.length);
  }
  if (text.includes("2 ** ") || text.includes("Math.pow(")) {
    for (const match of text.matchAll(BACKOFF_WAIT)) starts.push(match.index);
  }
  return starts.sort((a, b) => a - b).map((start) => hitAt(text, start));
}

function hitAt(text, start) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", start);
  return {
    line: text.slice(0, start).split("\n").length,
    text: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
  };
}
