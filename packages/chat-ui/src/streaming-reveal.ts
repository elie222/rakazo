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
/**
 * Past this length a block reveals without per-unit spans. A single growing paragraph or a link
 * definition that prevents splitting would otherwise rebuild thousands of spans on every chunk.
 */
const REVEAL_MAX_BLOCK_CHARS = 20_000;
const REVEAL_FALLBACK_WORD_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const REVEAL_CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Source of one block, with the offset it starts at in the whole message source. */
type BlockSource = { source: string; start: number };

/** Progress one render pass wrote for a block, committed only if that pass reaches the screen. */
type PendingBlock = BlockSource & {
  pass: number;
  units: number;
  now: number;
};

export type StreamingRevealState = {
  /** Source of each block seen so far, by the block's stable key. */
  blocks: Map<string, BlockSource>;
  /** Progress written by render passes that have not committed yet. */
  pending: Map<string, PendingBlock>;
  /** Incremented once per render pass so an abandoned pass cannot commit its progress. */
  pass: number;
  /** End of the last unit scheduled in the current pass, so later blocks continue after it. */
  passClock: number;
  /** Arrival speed in units per millisecond, smoothed; unknown until the first commit. */
  rate: number | undefined;
  /** Smoothed gap between two batches of new units, in milliseconds. */
  gap: number | undefined;
  /** When the previous batch of new units arrived. */
  arrival: number;
  /** Whether this frame is a live append; a mount, backfill or session switch never animates. */
  incremental: boolean;
  /** Whether the previous committed render was streaming. Existing text settles when it starts. */
  wasStreaming: boolean;
};

export function createStreamingRevealState(): StreamingRevealState {
  return {
    blocks: new Map(),
    pending: new Map(),
    pass: 0,
    passClock: Number.NEGATIVE_INFINITY,
    rate: undefined,
    gap: undefined,
    arrival: Number.NEGATIVE_INFINITY,
    incremental: false,
    wasStreaming: false,
  };
}

let cachedWordSegmenter: Intl.Segmenter | null | undefined;
let cachedGraphemeSegmenter: Intl.Segmenter | null | undefined;

function getWordSegmenter(): Intl.Segmenter | null {
  if (cachedWordSegmenter !== undefined) return cachedWordSegmenter;
  cachedWordSegmenter =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;
  return cachedWordSegmenter;
}

function getGraphemeSegmenter(): Intl.Segmenter | null {
  if (cachedGraphemeSegmenter !== undefined) return cachedGraphemeSegmenter;
  cachedGraphemeSegmenter =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  return cachedGraphemeSegmenter;
}

/** A kana and its combining voiced mark are one drawn character, so they reveal together. */
function graphemeUnits(word: string): string[] {
  const segmenter = getGraphemeSegmenter();
  return segmenter
    ? Array.from(segmenter.segment(word), ({ segment }) => segment)
    : Array.from(word);
}

/**
 * Latin text reveals by word, Chinese and Japanese by character. ICU word segmentation groups
 * words like 拍板 or 决策 into one unit, so a CJK fragment is split into grapheme clusters.
 */
export function segmentRevealUnits(text: string): string[] {
  const segmenter = getWordSegmenter();
  const words = segmenter
    ? Array.from(segmenter.segment(text), ({ segment }) => segment)
    : (text.match(REVEAL_FALLBACK_WORD_RE) ?? [text]);
  const units: string[] = [];
  for (const word of words) {
    if (REVEAL_CJK_RE.test(word)) units.push(...graphemeUnits(word));
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

function lastBlock(state: StreamingRevealState): BlockSource | undefined {
  let tail: BlockSource | undefined;
  for (const block of state.blocks.values()) tail = block;
  return tail;
}

/**
 * Runs after the render is committed. Only the pass that reached the screen may record progress;
 * entries from interrupted passes are dropped, and blocks no longer in the message are forgotten.
 */
export function commitStreamingReveal(
  state: StreamingRevealState,
  pass: number,
  blockKeys: readonly string[],
) {
  const current = new Set(blockKeys);
  for (const key of state.blocks.keys()) {
    if (!current.has(key)) state.blocks.delete(key);
  }
  let units = 0;
  let arrival = Number.NEGATIVE_INFINITY;
  for (const [key, pending] of state.pending) {
    state.pending.delete(key);
    if (pending.pass !== pass) continue;
    state.blocks.set(key, { source: pending.source, start: pending.start });
    units += pending.units;
    arrival = Math.max(arrival, pending.now);
  }
  if (units === 0) return;
  // Only a continuous stream updates the speed. A pause keeps the previous speed, or a burst
  // after a pause would be scheduled at the slow pace it looked like it had.
  const gap = arrival - state.arrival;
  if (gap <= REVEAL_PAUSE_MS) {
    const instant = units / Math.max(gap, REVEAL_MIN_GAP_MS);
    state.rate =
      state.rate === undefined ? instant : state.rate + (instant - state.rate) * REVEAL_RATE_ALPHA;
    state.gap = state.gap === undefined ? gap : state.gap + (gap - state.gap) * REVEAL_RATE_ALPHA;
  }
  state.arrival = arrival;
}

type RevealSlot =
  | {
      kind: "text";
      parent: HastNode;
      index: number;
      start: number;
      end: number;
      value: string;
      units: string[];
    }
  | { kind: "element"; node: HastNode; start: number }
  | { kind: "marker"; node: HastNode; start: number };
type RevealTextSlot = Extract<RevealSlot, { kind: "text" }>;

type RevealSchedule = { now: number; start: number; interval: number };

function clampRevealMs(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Schedules this batch of new units and returns the arrival time and the gap between units. The
 * batch starts now and is spread to finish within the target lag, where the lag grows with arrival
 * speed. This keeps a slow model visibly typing and stops a fast burst from queueing seconds of
 * delay. Blocks render in order, so each batch starts at the current frame instead of chaining.
 */
function planRevealSchedule(state: StreamingRevealState, count: number): RevealSchedule {
  const now = performance.now();
  const perUnit = state.rate !== undefined ? 1 / state.rate : REVEAL_FIRST_WINDOW_MS / count;
  const lag = clampRevealMs(
    Math.max(REVEAL_LAG_UNITS * perUnit, REVEAL_LAG_GAP_FACTOR * (state.gap ?? 0)),
    REVEAL_MIN_LAG_MS,
    REVEAL_MAX_LAG_MS,
  );
  // The whole append, however many blocks it adds, must finish revealing within the lag bound.
  const tail = Math.max(state.passClock, now);
  const ceiling = Math.max(0, now + REVEAL_MAX_LAG_MS - tail);
  const available = Math.min(ceiling, Math.max(now + lag - tail, REVEAL_MIN_SPREAD_MS));
  const interval = Math.min(REVEAL_MAX_INTERVAL_MS, available / count);
  const start = Math.max(now, state.passClock + interval);
  state.passClock = start + (count - 1) * interval;
  return {
    now,
    start,
    interval,
  };
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

/** Source offset of a node, or zero when the parser supplied no position. */
function sourceOffset(node: HastNode, fallback: number): number {
  return node.position?.start?.offset ?? fallback;
}

/** ASCII punctuation is the only set a CommonMark backslash escapes. */
function isAsciiPunctuation(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

/**
 * Rendered characters of a text node that were on screen before `revealed`. Source offsets count
 * entity spelling (`&amp;`) and escapes, so the slice is decoded before it is compared with the
 * node's rendered value.
 */
function visiblePrefix(slot: RevealTextSlot, blockSource: string, revealed: number): number {
  if (revealed === Number.POSITIVE_INFINITY || revealed >= slot.end) return slot.value.length;
  if (revealed <= slot.start) return 0;
  const limit = revealed - slot.start;
  const source = blockSource.slice(slot.start, slot.end);
  let index = 0;
  let rendered = 0;
  while (index < limit && rendered < slot.value.length) {
    const char = source[index];
    // An escape or entity that crosses the boundary was still literal in the previous frame.
    if (char === "\\" && index + 1 < limit && isAsciiPunctuation(source[index + 1])) {
      index += 2;
      rendered += 1;
      continue;
    }
    // A decoded reference no longer spells itself in the rendered text. Trusting the parser's
    // output covers every named entity without keeping a reference table of our own.
    if (char === "&") {
      const semicolon = source.indexOf(";", index + 1);
      // A reference completed by this append starts before the boundary and ends after it; the
      // previous frame still drew its spelling, so the decoded character belongs to this frame.
      if (semicolon !== -1 && semicolon - index <= 34) {
        const spelling = source.slice(index, semicolon + 1);
        if (!slot.value.startsWith(spelling, rendered)) {
          const next = source[semicolon + 1];
          if (next === undefined) {
            rendered = slot.value.length;
          } else {
            const nextAt = slot.value.indexOf(next, rendered);
            rendered = nextAt > rendered ? nextAt : Math.min(slot.value.length, rendered + 1);
          }
          index = semicolon + 1;
          continue;
        }
      }
    }
    index += 1;
    rendered += 1;
  }
  return Math.min(slot.value.length, rendered);
}

/**
 * How much of the block's source was already on screen before this version. The source is the
 * stable coordinate: closing markdown formatting rewrites the rendered text without moving the
 * text that was already visible, so the appended source is exactly what is new.
 */
function revealedSourceLength(
  state: StreamingRevealState,
  blockKey: string,
  blockSource: string,
  blockStart: number,
): number {
  if (!state.incremental) return Number.POSITIVE_INFINITY;
  const previous = state.blocks.get(blockKey);
  if (previous) {
    return blockSource.startsWith(previous.source)
      ? previous.source.length
      : Number.POSITIVE_INFINITY;
  }
  // A reference definition switches parsing from split blocks to one root block. The previous
  // block sources concatenate to the previous full source, so its prefix is already visible.
  if (blockKey === "root-0") {
    const fullSource = [...state.blocks.values()].map((block) => block.source).join("");
    return fullSource.length > 0 && blockSource.startsWith(fullSource) ? fullSource.length : 0;
  }
  // A replacement at the same source offset (a paragraph becoming a list item) keeps the prefix
  // it already drew. A block that starts later is new text and fades in from the beginning.
  const tail = lastBlock(state);
  return tail && tail.start === blockStart && blockSource.startsWith(tail.source)
    ? tail.source.length
    : 0;
}

/**
 * Wraps every rendered unit in a span that carries its fade-in delay. Units that were already on
 * screen are marked settled and keep their DOM position; new units are appended, so React never
 * reuses an existing span for different text.
 */
export function createStreamingRevealPlugin(
  state: StreamingRevealState,
  blockKey: string,
  blockSource: string,
  blockStart: number,
) {
  return function streamingRevealRehypePlugin() {
    return (tree: HastNode) => {
      const slots: RevealSlot[] = [];

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
                start: sourceOffset(child, 0),
                end: child.position?.end?.offset ?? 0,
                value,
                units: [],
              });
            }
            continue;
          }
          const tagName = child.tagName;
          const childSkip = skip || (tagName !== undefined && REVEAL_SKIP_TAGS.has(tagName));
          // A list marker is a pseudo-element, not a text node. Schedule it before the item's
          // first unit so the bullet fades in with the text; the stylesheet transitions its color.
          if (!childSkip && tagName === "li") {
            slots.push({ kind: "marker", node: child, start: sourceOffset(child, 0) });
          }
          // Code inside a pre is skipped with it; reaching here means inline code, which fades in
          // as one unit alongside the words around it.
          if (!childSkip && tagName === "code") {
            if (collectHastText(child).length === 0) continue;
            if (!isMathCodeElement(child)) {
              slots.push({ kind: "element", node: child, start: sourceOffset(child, 0) });
            }
            continue;
          }
          walk(child, childSkip);
        }
      };
      walk(tree, false);

      const tooLong = blockSource.length > REVEAL_MAX_BLOCK_CHARS;
      if (!tooLong) {
        for (const slot of slots) {
          if (slot.kind === "text") slot.units = segmentRevealUnits(slot.value);
        }
      }
      const revealed = tooLong
        ? Number.POSITIVE_INFINITY
        : revealedSourceLength(state, blockKey, blockSource, blockStart);

      let fresh = 0;
      for (const slot of slots) {
        if (slot.kind !== "text") {
          if (slot.start >= revealed) fresh += 1;
          continue;
        }
        const visible = visiblePrefix(slot, blockSource, revealed);
        let cursor = 0;
        for (const unit of slot.units) {
          if (cursor >= visible && unit.trim().length > 0) fresh += 1;
          cursor += unit.length;
        }
      }
      const schedule = fresh > 0 ? planRevealSchedule(state, fresh) : undefined;
      state.pending.set(blockKey, {
        source: blockSource,
        start: blockStart,
        pass: state.pass,
        units: fresh,
        now: schedule?.now ?? performance.now(),
      });

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
        const visible = visiblePrefix(slot, blockSource, revealed);
        let cursor = 0;
        const out: HastNode[] = [];
        for (const unit of slot.units) {
          if (unit.trim().length === 0) {
            out.push({ type: "text", value: unit });
          } else {
            out.push({
              type: "element",
              tagName: "span",
              properties:
                cursor >= visible ? nextRevealProperties() : { "data-rk-reveal": "settled" },
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
