/**
 * Finds many values in a text in one pass (Aho–Corasick over UTF-16 code units, as `indexOf`
 * matches), so the cost grows with the text and the matches rather than with values × text.
 */
export type SecretMatcher = {
  /** True when there is no value to find. */
  empty: boolean;
  /** The stretches values cover, in order, as [start, end); overlapping matches make one stretch. */
  ranges(text: string): Array<[number, number]>;
  /** Whether any value occurs in `text`. */
  test(text: string): boolean;
};

const ROOT = 0;

/**
 * The most states the one-pass matcher builds. Its states grow with the values' combined length,
 * which very long values (keys of thousands of characters, each in several encodings) could push
 * past what a Map holds; past this, each value is scanned for in turn instead.
 */
const MAX_SECRET_MATCHER_STATES = 1_000_000;

/**
 * Scanned work, in values × text code units, worth one code unit of building the one-pass
 * matcher: building costs about a Map write per code unit of the values, a scan a compare.
 */
const BUILD_COST = 8;

/**
 * Scans for each value in turn until the scans have cost about what building the one-pass matcher
 * would, then builds it. A short text checked against a fresh list, as a field's check is, costs
 * what one scan always did; long texts, or many over one list, get the one-pass matcher.
 */
export function createSecretMatcher(values: readonly string[]): SecretMatcher {
  const scanning = scanningMatcher(values);
  if (scanning.empty) return scanning;
  const present = values.filter(Boolean);
  const budget = present.reduce((total, value) => total + value.length, 0) * BUILD_COST;
  let scanned = 0;
  let indexed: SecretMatcher | undefined;
  const pick = (text: string) => {
    if (indexed) return indexed;
    scanned += text.length * present.length;
    if (scanned <= budget) return scanning;
    indexed = createIndexedMatcher(present);
    return indexed;
  };
  return {
    empty: false,
    ranges: (text) => pick(text).ranges(text),
    test: (text) => pick(text).test(text),
  };
}

/** The one-pass matcher, or past `maxStates` states the per-value scan. */
export function createIndexedMatcher(
  values: readonly string[],
  maxStates = MAX_SECRET_MATCHER_STATES,
): SecretMatcher {
  // Each state's children, keyed by state and code unit in one map.
  const children = new Map<number, number>();
  const key = (state: number, code: number) => state * 0x10000 + code;
  const depth = [0];
  // The longest value that ends at this state, as a suffix of the text read so far; 0 when none.
  const longest = [0];
  for (const value of values) {
    if (!value) continue;
    let state = ROOT;
    for (let index = 0; index < value.length; index += 1) {
      const edge = key(state, value.charCodeAt(index));
      let child = children.get(edge);
      if (child === undefined) {
        if (depth.length >= maxStates) return scanningMatcher(values);
        child = depth.length;
        depth.push(index + 1);
        longest.push(0);
        children.set(edge, child);
      }
      state = child;
    }
    longest[state] = value.length;
  }

  const fail = new Int32Array(depth.length);
  // Breadth first, so a state's fallback is settled before its children need it.
  const byState = new Map<number, Array<[number, number]>>();
  for (const [edge, child] of children) {
    const parent = Math.floor(edge / 0x10000);
    const list = byState.get(parent) ?? [];
    list.push([edge - parent * 0x10000, child]);
    byState.set(parent, list);
  }
  const queue: number[] = [ROOT];
  for (let head = 0; head < queue.length; head += 1) {
    const state = queue[head]!;
    for (const [code, child] of byState.get(state) ?? []) {
      if (state !== ROOT) {
        let fallback = fail[state]!;
        while (fallback !== ROOT && !children.has(key(fallback, code))) fallback = fail[fallback]!;
        fail[child] = children.get(key(fallback, code)) ?? ROOT;
      }
      if (longest[child] === 0) longest[child] = longest[fail[child]!]!;
      queue.push(child);
    }
  }
  const empty = depth.length === 1;

  /** Calls `found(end, length)` with the longest value ending at each offset that ends one. */
  const scan = (text: string, found: (end: number, length: number) => boolean | undefined) => {
    let state = ROOT;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      let child = children.get(key(state, code));
      while (child === undefined && state !== ROOT) {
        state = fail[state]!;
        child = children.get(key(state, code));
      }
      state = child ?? ROOT;
      const length = longest[state]!;
      if (length > 0 && found(index + 1, length)) return;
    }
  };

  return {
    empty,
    ranges(text) {
      if (empty) return [];
      // Of the matches ending at one offset only the longest counts: the others lie inside it,
      // so they overlap it and can't change a stretch. Ends only grow, so a match that starts
      // before the current stretch ends joins it; one that only touches it starts another.
      const ranges: Array<[number, number]> = [];
      scan(text, (end, length) => {
        const start = end - length;
        const last = ranges.at(-1);
        if (last && start < last[1]) last[0] = Math.min(last[0], start);
        else ranges.push([start, end]);
        // A match starting before earlier stretches swallows them too.
        while (ranges.length > 1 && ranges.at(-1)![0] < ranges.at(-2)![1]) {
          const [merged] = ranges.splice(-1, 1);
          const previous = ranges.at(-1)!;
          previous[0] = Math.min(previous[0], merged![0]);
          previous[1] = merged![1];
        }
        const current = ranges.at(-1)!;
        current[1] = end;
        return undefined;
      });
      return ranges;
    },
    test(text) {
      if (empty) return false;
      let found = false;
      scan(text, () => {
        found = true;
        return true;
      });
      return found;
    },
  };
}

/** Scans for each value in turn: memory stays at the text's length, time grows with values × text. */
function scanningMatcher(values: readonly string[]): SecretMatcher {
  const present = values.filter(Boolean);
  return {
    empty: present.length === 0,
    ranges(text) {
      // Count matches starting and ending at each offset rather than listing every match, so a
      // value that repeats or overlaps itself costs no more than two counters per offset.
      let starts: Int32Array | undefined;
      let ends: Int32Array | undefined;
      for (const value of present) {
        for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
          starts ??= new Int32Array(text.length + 1);
          ends ??= new Int32Array(text.length + 1);
          starts[at] = starts[at]! + 1;
          ends[at + value.length] = ends[at + value.length]! + 1;
        }
      }
      if (!starts || !ends) return [];
      const ranges: Array<[number, number]> = [];
      let open = 0;
      let start = 0;
      for (let offset = 0; offset <= text.length; offset += 1) {
        const ending = ends[offset]!;
        const starting = starts[offset]!;
        if (ending === 0 && starting === 0) continue;
        open -= ending;
        if (ending > 0 && open === 0) ranges.push([start, offset]);
        if (starting > 0 && open === 0) start = offset;
        open += starting;
      }
      return ranges;
    },
    test(text) {
      return present.some((value) => text.includes(value));
    },
  };
}
