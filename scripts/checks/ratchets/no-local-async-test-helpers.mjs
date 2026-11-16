export const message =
  "Do not hand-write an async test helper. To hold a call open and release it later, use deferred() from @rakazo/core/test-async; to let a due timer and the promise callbacks queued before it run, use flush() from the same module; to wait for a condition, use vi.waitFor(assertion) or vi.waitUntil(check) instead of a loop that sleeps.";

export const include = [
  "{packages,apps,infra}/**/*.test.{ts,tsx}",
  "{packages,apps,infra}/**/*test-support*.{ts,tsx}",
];

// Browser specs run outside vitest and have their own waits (no-wait-for-timeout).
export const exclude = ["**/e2e/**", "packages/core/src/async.test-support.ts"];

// A type argument, with `=>` and up to three levels of nesting: `<Array<{ done: () => void }>>`.
const TYPE = "(?:<(?:=>|[^<>]|<(?:=>|[^<>]|<(?:=>|[^<>])*>)*>)*>)?";
const PARAMS = String.raw`\(?\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)?\s*=>\s*`;
// The executor does nothing but hand its resolvers to variables declared outside it.
const CAPTURE = String.raw`[\w$.]+\s*=\s*(?:\1|\2)`;
const DEFERRED = String.raw`(?:\{\s*${CAPTURE}\s*;?\s*(?:${CAPTURE}\s*;?\s*)?\}|\(?\s*${CAPTURE}\s*\)?)`;
// The executor does nothing but resolve from a timer that is already due.
const FLUSH = String.raw`\{?\s*setTimeout\(\s*(?:\1|\(\)\s*=>\s*\1\(\))\s*(?:,\s*0\s*)?\)\s*;?\s*\}?`;
const HAND_ROLLED = new RegExp(
  String.raw`new Promise${TYPE}\(\s*${PARAMS}(?:${DEFERRED}|${FLUSH})\s*,?\s*\)`,
  "g",
);

const LOOP = /^([ \t]*)(?:(?:for|while) \([^\n]*\{|do \{)$/gm;
const TIMER_SLEEP =
  /\bawait new Promise(?:<[^>]*>)?\(\s*\(?\s*\w+\s*\)?\s*=>\s*\{?\s*setTimeout\(\s*\w+\s*,\s*(?!0\s*\))/g;
const LEAVES = /\b(?:return|break|throw)\b/;
// `while (!ready)` sleeps until its own condition changes; `while (true)` needs a way out to poll.
const CONDITIONED = /^[ \t]*while \((?!true\))/;
const BRACELESS_POLL =
  /^[ \t]*while \((?!true\))[^\n]*\)\s*await new Promise(?:<[^>]*>)?\(\s*\(?\s*\w+\s*\)?\s*=>\s*setTimeout\(/gm;

/**
 * A promise whose resolvers are captured, a promise resolved by a timer that is already due, and
 * a loop that sleeps on a timer between looks at a condition.
 */
export function count(text) {
  if (!text.includes("new Promise")) return [];
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  const hits = [];
  for (const match of text.matchAll(HAND_ROLLED)) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const lineEnd = text.indexOf("\n", match.index);
    hits.push({
      line: lineOf(match.index),
      text: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
    });
  }
  for (const match of text.matchAll(BRACELESS_POLL))
    hits.push({ line: lineOf(match.index), text: match[0].split("\n")[0].trim() });
  const sleeps = [...text.matchAll(TIMER_SLEEP)];
  if (sleeps.length === 0) return hits.sort((a, b) => a.line - b.line);
  const loops = [...text.matchAll(LOOP)].map((match) => {
    const start = match.index + match[0].length;
    // Formatted code closes a block at the first line indented no deeper than its opener.
    const close = text.slice(start).search(new RegExp(`\\n[ \\t]{0,${match[1].length}}\\S`));
    return { match, start, end: close === -1 ? text.length : start + close };
  });
  const polls = new Set();
  for (const sleep of sleeps) {
    // The innermost loop around the sleep is the one that polls.
    const loop = loops.findLast(({ start, end }) => start < sleep.index && sleep.index < end);
    if (!loop) continue;
    if (CONDITIONED.test(loop.match[0]) || LEAVES.test(text.slice(loop.start, loop.end)))
      polls.add(loop.match);
  }
  for (const match of polls) hits.push({ line: lineOf(match.index), text: match[0].trim() });
  return hits.sort((a, b) => a.line - b.line);
}
