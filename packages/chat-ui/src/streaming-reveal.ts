import type { HastNode } from "./table-utils";

/**
 * Fades streamed text in one unit at a time: a word in Latin scripts, a character in Chinese or
 * Japanese. The DOM text is complete from the first frame and only opacity animates, so the
 * bubble never changes height and the transcript keeps its scroll position.
 */

/**
 * Code blocks, diagrams and math highlight asynchronously, the table card derives its sort labels
 * from plain-text cells, and a link label is derived from its text children: none of them fade in.
 */
const REVEAL_SKIP_TAGS = new Set(["pre", "svg", "math", "table", "a"]);
/** Longest gap between two units starting to fade in, when the model streams slowly. */
const REVEAL_MAX_INTERVAL_MS = 40;
/** Furthest a unit may lag behind arrival, which also bounds a slow start after a burst. */
const REVEAL_MAX_LAG_MS = 250;
/** Smallest target lag, so a fast burst still spreads over a few frames. */
const REVEAL_MIN_LAG_MS = 80;
/** Target lag in units, and as a multiple of the gap between two arrivals. */
const REVEAL_LAG_UNITS = 6;
const REVEAL_LAG_GAP_FACTOR = 1.5;
/** A batch that is already behind still spreads over at least this long. */
const REVEAL_MIN_SPREAD_MS = 15;
/** A longer pause is a new burst, not a change in arrival speed. */
const REVEAL_PAUSE_MS = 300;
const REVEAL_RATE_ALPHA = 0.3;
/** Two commits closer than this are treated as one window, so speed is never estimated as infinite. */
const REVEAL_MIN_GAP_MS = 10;
/** Without a speed reference, a batch is assumed to have arrived within one frame. */
const REVEAL_FIRST_WINDOW_MS = 30;
/**
 * A larger source jump is a mount, backfill or session switch, not a live delta; the whole
 * message appears without animation. A normal frame is a few characters.
 */
const REVEAL_MAX_DELTA_CHARS = 600;
/** Only trailing blocks still change; earlier ones are frozen, so a few recent entries are enough. */
const REVEAL_COMMITTED_BLOCK_CAP = 16;
/** The next version of a block may rewrite trailing whitespace or punctuation. */
const REVEAL_TAIL_SLACK_CHARS = 8;
const REVEAL_WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const REVEAL_FALLBACK_WORD_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const REVEAL_CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

type RevealPlan = {
  /** When this batch arrived, on the `performance.now()` timeline. */
  now: number;
  start: number;
  interval: number;
  end: number;
  count: number;
};

export type StreamingRevealState = {
  /** Rendered text of recently committed blocks; the plugin only reads it while rendering. */
  committed: string[];
  /** Rendered texts produced by the current render pass, committed after it is on screen. */
  pending: string[];
  /** Start time of the last scheduled unit, so batches continue each other's rhythm. */
  clock: number;
  /** Arrival speed in units per millisecond, smoothed; unknown until the first commit. */
  rate: number | undefined;
  /** Smoothed gap between two batches of new units, in milliseconds. */
  gap: number | undefined;
  /** When the previous batch of new units arrived. */
  arrival: number;
  pendingSchedules: Map<string, RevealPlan>;
  /** Whether this frame is a live append; a mount, backfill or session switch never animates. */
  incremental: boolean;
};

export function createStreamingRevealState(): StreamingRevealState {
  return {
    committed: [],
    pending: [],
    clock: Number.NEGATIVE_INFINITY,
    rate: undefined,
    gap: undefined,
    arrival: Number.NEGATIVE_INFINITY,
    pendingSchedules: new Map(),
    incremental: false,
  };
}

let cachedWordSegmenter: Intl.Segmenter | null | undefined;

function getWordSegmenter(): Intl.Segmenter | null {
  if (cachedWordSegmenter !== undefined) return cachedWordSegmenter;
  cachedWordSegmenter =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;
  return cachedWordSegmenter;
}

/**
 * Latin text reveals by word, Chinese and Japanese by character. ICU word segmentation groups
 * words like 拍板 or 决策 into one unit, so a CJK fragment is split into code points.
 */
export function segmentRevealUnits(text: string): string[] {
  const segmenter = getWordSegmenter();
  const words = segmenter
    ? Array.from(segmenter.segment(text), ({ segment }) => segment)
    : (text.match(REVEAL_FALLBACK_WORD_RE) ?? [text]);
  const units: string[] = [];
  for (const word of words) {
    if (REVEAL_CJK_RE.test(word)) units.push(...Array.from(word));
    else units.push(word);
  }
  return units;
}

/** A non-prefix change is a snapshot backfill, session switch or rewrite: everything is settled. */
export function isIncrementalRevealSource(previous: string, next: string): boolean {
  return (
    next.length > previous.length &&
    next.length - previous.length <= REVEAL_MAX_DELTA_CHARS &&
    next.startsWith(previous)
  );
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

/**
 * How much of `text` was already revealed by its previous version `entry`, or 0 when `entry` is
 * not a predecessor. A near-prefix with only whitespace or punctuation in the tail counts: the
 * next version of a block rewrites trailing whitespace or closes markdown. A tail containing a
 * word character is other content that merely shares a prefix, so it must not pass as progress.
 */
function revealPredecessorLength(text: string, entry: string): number {
  const prefix = commonPrefixLength(text, entry);
  if (prefix === 0) return 0;
  const tail = entry.slice(prefix);
  return tail.length <= REVEAL_TAIL_SLACK_CHARS && !REVEAL_WORD_CHAR_RE.test(tail) ? prefix : 0;
}

function resolveRevealedLength(blockText: string, committed: readonly string[]): number {
  let revealed = 0;
  for (const entry of committed) {
    revealed = Math.max(revealed, revealPredecessorLength(blockText, entry));
  }
  return revealed;
}

/**
 * Runs after the render is committed. New units were scheduled during render; folding them in
 * here lets the next render read the progress the previous frame reached.
 */
export function commitStreamingReveal(state: StreamingRevealState) {
  if (state.pendingSchedules.size > 0) {
    let count = 0;
    let arrival = Number.NEGATIVE_INFINITY;
    for (const planned of state.pendingSchedules.values()) {
      state.clock = Math.max(state.clock, planned.end);
      count += planned.count;
      arrival = Math.max(arrival, planned.now);
    }
    state.pendingSchedules.clear();
    // Only a continuous stream updates the speed. A pause keeps the previous speed, or a burst
    // after a pause would be scheduled at the slow pace it looked like it had.
    const gap = arrival - state.arrival;
    if (gap <= REVEAL_PAUSE_MS) {
      const instant = count / Math.max(gap, REVEAL_MIN_GAP_MS);
      state.rate =
        state.rate === undefined
          ? instant
          : state.rate + (instant - state.rate) * REVEAL_RATE_ALPHA;
      state.gap = state.gap === undefined ? gap : state.gap + (gap - state.gap) * REVEAL_RATE_ALPHA;
    }
    state.arrival = arrival;
  }
  if (state.pending.length === 0) return;
  let committed = state.committed;
  for (const text of state.pending) {
    if (text.length === 0) continue;
    // A block's next version replaces its previous one. The same rule as
    // resolveRevealedLength also dedupes the same text pushed twice by StrictMode.
    committed = committed.filter((entry) => revealPredecessorLength(text, entry) === 0);
    committed.push(text);
  }
  state.committed = committed.slice(-REVEAL_COMMITTED_BLOCK_CAP);
  state.pending = [];
}

type RevealSlot =
  | { kind: "text"; parent: HastNode; index: number; start: number; units: string[] }
  | { kind: "element"; node: HastNode; start: number }
  | { kind: "marker"; node: HastNode; start: number };

type RevealSchedule = { now: number; start: number; interval: number };

function clampRevealMs(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Schedules this batch of new units and returns when the first one starts and how far apart they
 * are. A new batch continues after the last unit already scheduled, and is spread to finish
 * before "now + target lag", where the target lag grows with arrival speed. This keeps a slow
 * model visibly typing and stops a fast one from queueing seconds of delay.
 */
function planRevealSchedule(
  state: StreamingRevealState,
  blockText: string,
  count: number,
): RevealSchedule {
  const now = performance.now();
  // The same block rendered again before commit: reuse its schedule instead of queueing twice.
  const planned = state.pendingSchedules.get(blockText);
  if (planned) return { now, start: planned.start, interval: planned.interval };
  // Later blocks in the same pass continue after earlier ones. A prefix version of the current
  // text is a discarded render whose units never reached the screen, so it does not count.
  let clock = state.clock;
  for (const [key, entry] of state.pendingSchedules) {
    if (blockText.startsWith(key)) state.pendingSchedules.delete(key);
    else clock = Math.max(clock, entry.end);
  }
  const perUnit = state.rate !== undefined ? 1 / state.rate : REVEAL_FIRST_WINDOW_MS / count;
  const lag = clampRevealMs(
    Math.max(REVEAL_LAG_UNITS * perUnit, REVEAL_LAG_GAP_FACTOR * (state.gap ?? 0)),
    REVEAL_MIN_LAG_MS,
    REVEAL_MAX_LAG_MS,
  );
  const tail = Math.max(clock, now);
  const ceiling = Math.max(0, now + REVEAL_MAX_LAG_MS - tail);
  const available = Math.min(ceiling, Math.max(now + lag - tail, REVEAL_MIN_SPREAD_MS));
  const interval = Math.min(REVEAL_MAX_INTERVAL_MS, available / count);
  const start = Math.max(now, clock + interval);
  state.pendingSchedules.set(blockText, {
    now,
    start,
    interval,
    end: start + (count - 1) * interval,
    count,
  });
  return { now, start, interval };
}

/** Appends reveal properties to an existing hast element, keeping any inline style it had. */
function mergeRevealProperties(node: HastNode, extra: Record<string, string>) {
  const existingStyle = node.properties?.style;
  node.properties = {
    ...node.properties,
    ...extra,
    ...(typeof existingStyle === "string" && existingStyle && extra.style
      ? { style: `${existingStyle};${extra.style}` }
      : {}),
  };
}

function collectHastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(collectHastText).join("");
}

function isMathCodeElement(node: HastNode): boolean {
  const className = node.properties?.className;
  return (
    Array.isArray(className) &&
    className.some((name) => name === "language-math" || name === "math-inline")
  );
}

/**
 * Wraps every rendered unit in a span that carries its fade-in delay. Units that were already
 * on screen are marked settled and keep their DOM position; new units are appended, so React
 * never reuses an existing span for different text.
 */
export function createStreamingRevealPlugin(state: StreamingRevealState) {
  return function streamingRevealRehypePlugin() {
    return (tree: HastNode) => {
      const slots: RevealSlot[] = [];
      const blockTexts: string[] = [];
      let offset = 0;

      const walk = (node: HastNode, skip: boolean) => {
        const children = node.children;
        if (!children) return;
        for (let index = 0; index < children.length; index += 1) {
          const child = children[index];
          if (child === undefined) continue;
          if (child.type === "text") {
            const value = child.value ?? "";
            if (value.length === 0) continue;
            if (!skip) {
              slots.push({
                kind: "text",
                parent: node,
                index,
                start: offset,
                units: segmentRevealUnits(value),
              });
            }
            // Skipped text still occupies offsets, so prefix comparisons follow render order.
            blockTexts.push(value);
            offset += value.length;
            continue;
          }
          const tagName = child.tagName;
          const childSkip = skip || (tagName !== undefined && REVEAL_SKIP_TAGS.has(tagName));
          // A list marker is a pseudo-element, not a text node. Schedule it before the item's
          // first unit so the bullet fades in with the text; the stylesheet transitions its color.
          if (!childSkip && tagName === "li") {
            slots.push({ kind: "marker", node: child, start: offset });
          }
          // Code inside a pre is skipped with it; reaching here means inline code, which fades in
          // as one unit alongside the words around it.
          if (!childSkip && tagName === "code") {
            const text = collectHastText(child);
            if (text.length === 0) continue;
            if (!isMathCodeElement(child)) {
              slots.push({ kind: "element", node: child, start: offset });
            }
            blockTexts.push(text);
            offset += text.length;
            continue;
          }
          walk(child, childSkip);
        }
      };
      walk(tree, false);

      const blockText = blockTexts.join("");
      // Record progress even when nothing animates, or the next frame would treat it all as new.
      state.pending.push(blockText);
      if (slots.length === 0) return;
      const revealed = state.incremental
        ? resolveRevealedLength(blockText, state.committed)
        : Number.POSITIVE_INFINITY;

      let fresh = 0;
      for (const slot of slots) {
        if (slot.kind !== "text") {
          if (slot.start >= revealed) fresh += 1;
          continue;
        }
        let cursor = slot.start;
        for (const unit of slot.units) {
          if (cursor >= revealed && unit.trim().length > 0) fresh += 1;
          cursor += unit.length;
        }
      }
      const schedule = fresh > 0 ? planRevealSchedule(state, blockText, fresh) : undefined;
      let revealIndex = 0;
      const nextRevealDelay = () => {
        const delay = schedule
          ? schedule.start + revealIndex * schedule.interval - schedule.now
          : 0;
        revealIndex += 1;
        return `${delay.toFixed(1)}ms`;
      };
      // Only the delay is written here; the duration lives in the stylesheet.
      const nextRevealProperties = () => ({
        "data-rk-reveal": "new",
        style: `--rk-reveal-delay:${nextRevealDelay()}`,
      });

      const replacements = new Map<HastNode, Map<number, HastNode[]>>();
      for (const slot of slots) {
        if (slot.kind === "marker") {
          // A separate variable, or settled units inside the item would inherit the marker delay.
          mergeRevealProperties(
            slot.node,
            slot.start >= revealed
              ? {
                  "data-rk-reveal-marker": "new",
                  style: `--rk-reveal-marker-delay:${nextRevealDelay()}`,
                }
              : { "data-rk-reveal-marker": "settled" },
          );
          continue;
        }
        if (slot.kind === "element") {
          mergeRevealProperties(
            slot.node,
            slot.start >= revealed ? nextRevealProperties() : { "data-rk-reveal": "settled" },
          );
          continue;
        }
        let cursor = slot.start;
        const out: HastNode[] = [];
        for (const unit of slot.units) {
          if (unit.trim().length === 0) {
            out.push({ type: "text", value: unit });
          } else {
            out.push({
              type: "element",
              tagName: "span",
              properties:
                cursor >= revealed ? nextRevealProperties() : { "data-rk-reveal": "settled" },
              children: [{ type: "text", value: unit }],
            });
          }
          cursor += unit.length;
        }
        if (out.length === 0) continue;
        let perParent = replacements.get(slot.parent);
        if (!perParent) {
          perParent = new Map();
          replacements.set(slot.parent, perParent);
        }
        perParent.set(slot.index, out);
      }

      // Several text nodes may share a parent; rebuild its children once so indexes stay valid.
      for (const [parent, perParent] of replacements) {
        const children = parent.children;
        if (!children) continue;
        const next: HastNode[] = [];
        for (let index = 0; index < children.length; index += 1) {
          const replacement = perParent.get(index);
          const child = children[index];
          if (replacement) next.push(...replacement);
          else if (child !== undefined) next.push(child);
        }
        parent.children = next;
      }
    };
  };
}
