import { redactSecrets } from "../messages/events.js";

/** What redaction writes in place of a secret, taken from redaction itself so they cannot drift. */
const REDACTED_MARKER = redactSecrets("a", ["a"]);
const CONTEXT_LINES = 2;
/** Past this many removed plus added lines, the changed middle is shown as fully replaced. */
const MAX_CHANGED_LINES = 500;

/**
 * Lines match when they are equal, except one that holds the redaction marker: it may stand for a
 * real secret on one side and the same text typed out on the other, so it is never unchanged.
 */
function sameLine(a: string, b: string): boolean {
  return a === b && !a.includes(REDACTED_MARKER);
}

type DiffLine = { sign: " " | "-" | "+"; text: string };

/**
 * The fewest removed and added lines that turn `before` into `after` (Myers' algorithm), so the
 * work grows with how much changed rather than with the length of the text. Undefined when more
 * than MAX_CHANGED_LINES lines change.
 */
function shortestEdit(before: string[], after: string[]): DiffLine[] | undefined {
  const limit = Math.min(before.length + after.length, MAX_CHANGED_LINES);
  const offset = limit + 1;
  // furthest[offset + k]: how far into `before` the best path on diagonal k (x - y) has reached.
  const furthest = new Int32Array(2 * limit + 3);
  // rounds[d][k + d]: `furthest` for diagonals -d..d after d changed lines.
  const rounds: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && furthest[offset + k - 1]! < furthest[offset + k + 1]!)
          ? furthest[offset + k + 1]!
          : furthest[offset + k - 1]! + 1;
      let y = x - k;
      while (x < before.length && y < after.length && sameLine(before[x]!, after[y]!)) {
        x++;
        y++;
      }
      furthest[offset + k] = x;
      if (x >= before.length && y >= after.length) {
        rounds.push(furthest.slice(offset - d, offset + d + 1));
        return walkBack(before, after, rounds);
      }
    }
    rounds.push(furthest.slice(offset - d, offset + d + 1));
  }
  return undefined;
}

function walkBack(before: string[], after: string[], rounds: Int32Array[]): DiffLine[] {
  const reversed: DiffLine[] = [];
  let x = before.length;
  let y = after.length;
  const keep = (toX: number, toY: number) => {
    while (x > toX && y > toY) {
      reversed.push({ sign: " ", text: before[--x]! });
      y--;
    }
  };
  for (let d = rounds.length - 1; d > 0; d--) {
    const previous = (k: number) => rounds[d - 1]![k + d - 1]!;
    const k = x - y;
    const added = k === -d || (k !== d && previous(k - 1) < previous(k + 1));
    const fromK = added ? k + 1 : k - 1;
    const fromX = previous(fromK);
    const fromY = fromX - fromK;
    if (added) {
      keep(fromX, fromY + 1);
      reversed.push({ sign: "+", text: after[--y]! });
    } else {
      keep(fromX + 1, fromY);
      reversed.push({ sign: "-", text: before[--x]! });
    }
  }
  keep(0, 0);
  return reversed.reverse();
}

/** Within each run of changes, removals come first, as a reader expects. */
function removalsFirst(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = () => {
    out.push(
      ...run.filter((line) => line.sign === "-"),
      ...run.filter((line) => line.sign === "+"),
    );
    run = [];
  };
  for (const line of lines) {
    if (line.sign === " ") {
      flush();
      out.push(line);
    } else {
      run.push(line);
    }
  }
  flush();
  return out;
}

/** The lines both sides share are kept; everything else is a removal then an addition. */
function diffLines(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && sameLine(before[start]!, after[start]!))
    start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    sameLine(before[endBefore - 1]!, after[endAfter - 1]!)
  ) {
    endBefore--;
    endAfter--;
  }
  const head = before.slice(0, start).map((text): DiffLine => ({ sign: " ", text }));
  const tail = before.slice(endBefore).map((text): DiffLine => ({ sign: " ", text }));
  const removed = before.slice(start, endBefore);
  const added = after.slice(start, endAfter);
  const middle = shortestEdit(removed, added) ?? [
    ...removed.map((text): DiffLine => ({ sign: "-", text })),
    ...added.map((text): DiffLine => ({ sign: "+", text })),
  ];
  return [...head, ...removalsFirst(middle), ...tail];
}

/**
 * Only the changed lines, each with a couple of unchanged lines around it, and a count where
 * unchanged lines are left out. Every removed line stays visible so approving never hides a
 * dropped constraint.
 */
export function instructionUpdateDiff(before: string, after: string): string {
  if (!before.trim()) return after;
  const lines = diffLines(before.split("\n"), after.split("\n"));
  const shown = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.sign === " ") return;
    for (
      let near = Math.max(0, index - CONTEXT_LINES);
      near <= Math.min(lines.length - 1, index + CONTEXT_LINES);
      near++
    ) {
      shown[near] = true;
    }
  });
  const showAll = !shown.includes(true);
  const out: string[] = [];
  let hidden: string[] = [];
  // A single unchanged line takes no more room than a marker would, so it is shown instead.
  const flush = () => {
    if (hidden.length > 1) out.push(`… ${hidden.length} unchanged lines`);
    else out.push(...hidden);
    hidden = [];
  };
  lines.forEach((line, index) => {
    const text = `${line.sign} ${line.text}`;
    if (showAll || shown[index]) {
      flush();
      out.push(text);
    } else {
      hidden.push(text);
    }
  });
  flush();
  return out.join("\n");
}
