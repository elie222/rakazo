export const message =
  "Do not hand-write a loop that sleeps until a deadline. Use pollUntil(check, { intervalMs, timeoutMs, signal, waitingFor }) from @rakazo/core.";

export const include = [
  "{packages/{adapters,core,db,auth,memory,logging},apps/{api,worker},infra/sandboxes/supervisor,infra/updater}/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
];

export const exclude = [
  "**/*.{test,spec}.*",
  "**/*{.,-}test-support.*",
  "**/testing/**",
  "packages/core/src/primitives/{async,retry,retry-policy}.ts",
];

const DEADLINE = /^([ \t]*)(?:const|let) \w*deadline\w* = (?:[\w$]+\.)*now\(\) \+[^\n]*/gim;
const LOOP = /\b(?:while|for) \(|\bdo \{/;
// A timer raced against the work is a time limit, not a sleep between looks.
const WAIT =
  /\bawait\s+(?:(?:[\w$]+\.)*\w*(?:sleep|delay)\(|new Promise(?:<[^>]*>)?\(\s*\(?\w+\)?\s*=>\s*\{?\s*setTimeout\()/i;

/** A deadline taken from the clock that the rest of its block loops and sleeps against. */
export function count(text) {
  if (!/deadline/i.test(text)) return [];
  const hits = [];
  for (const match of text.matchAll(DEADLINE)) {
    const [statement, indent] = match;
    const after = match.index + statement.length;
    // Formatted code ends a block at the first line indented less than its statements.
    const outdent = indent
      ? text.slice(after).search(new RegExp(`\\n[ \\t]{0,${indent.length - 1}}\\S`))
      : -1;
    const rest = text.slice(after, outdent === -1 ? undefined : after + outdent);
    // A deadline handed to another function, or raced against, is not a poll loop.
    if (!LOOP.test(rest) || !WAIT.test(rest)) continue;
    hits.push({ line: text.slice(0, match.index).split("\n").length, text: statement.trim() });
  }
  return hits;
}
