/**
 * Stateful streaming scanner that tracks active match prefixes across chunks without rescanning
 * buffered text on every delta.
 */
export type SecretMatcherStream = {
  /**
   * Feeds `chunk` starting at stream offset `basePos`, reports every match `[start, end)` ending
   * in `chunk` via `onMatch`, and returns the longest active prefix length still pending at the
   * end of `chunk` (always strictly less than the longest pattern length).
   *
   * When an unindexed matcher promotes to an indexed automaton mid-stream, `readTail` supplies
   * the retained suffix immediately preceding `basePos` without flattening buffered chunks on
   * ordinary deltas.
   */
  feed(
    chunk: string,
    basePos: number,
    onMatch: (start: number, end: number) => void,
    readTail?: (length: number) => string,
  ): number;
  /** Resets incremental match state to the initial root state. */
  reset(): void;
};

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
  /** Creates stateful incremental scanning state for streaming redaction across chunks. */
  createStream(): SecretMatcherStream;
};

const ROOT = 0;

let indexedMatcherBuilds = 0;

/** Total one-pass matchers built in this process; used by tests to verify matcher promotion. */
export function indexedMatcherBuildCount(): number {
  return indexedMatcherBuilds;
}

const noopMatch = () => undefined;

const EMPTY_STREAM: SecretMatcherStream = {
  feed: () => 0,
  reset: () => undefined,
};

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
  let indexable = true;
  const ensureIndexed = (textLength: number): SecretMatcher | undefined => {
    if (indexed) return indexed;
    if (!indexable) return undefined;
    scanned += textLength * present.length;
    if (scanned <= budget) return undefined;
    const built = buildIndexedMatcher(present, MAX_SECRET_MATCHER_STATES);
    if (built) indexed = built;
    else indexable = false;
    return indexed;
  };
  const pick = (text: string) => ensureIndexed(text.length) ?? scanning;
  return {
    empty: false,
    ranges: (text) => pick(text).ranges(text),
    test: (text) => pick(text).test(text),
    createStream() {
      if (indexed) return indexed.createStream();
      let active = scanning.createStream();
      let activeIndexed = false;
      let pending = 0;
      return {
        feed(chunk, basePos, onMatch, readTail) {
          if (!activeIndexed) {
            const promoted = ensureIndexed(chunk.length);
            if (promoted && (pending === 0 || readTail !== undefined)) {
              active = promoted.createStream();
              activeIndexed = true;
              if (pending > 0 && readTail) {
                const replay = readTail(pending);
                if (replay.length > 0) {
                  active.feed(replay, basePos - replay.length, noopMatch);
                }
              }
            }
          }
          pending = active.feed(chunk, basePos, onMatch);
          return pending;
        },
        reset() {
          active.reset();
          pending = 0;
        },
      };
    },
  };
}

/** The one-pass matcher, or past `maxStates` states the per-value scan. */
export function createIndexedMatcher(
  values: readonly string[],
  maxStates = MAX_SECRET_MATCHER_STATES,
): SecretMatcher {
  return buildIndexedMatcher(values, maxStates) ?? scanningMatcher(values);
}

/** Builds the one-pass Aho-Corasick matcher, or `undefined` when it would exceed `maxStates`. */
function buildIndexedMatcher(
  values: readonly string[],
  maxStates: number,
): SecretMatcher | undefined {
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
        if (depth.length >= maxStates) return undefined;
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
  // Longest suffix of each state that is a proper prefix of some pattern (i.e. has a trie child).
  const pendingDepth = new Int32Array(depth.length);
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
      pendingDepth[child] = byState.has(child) ? depth[child]! : pendingDepth[fail[child]!]!;
      queue.push(child);
    }
  }
  const empty = depth.length === 1;
  if (!empty) indexedMatcherBuilds += 1;

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
    createStream() {
      if (empty) return EMPTY_STREAM;
      let state = ROOT;
      return {
        feed(chunk, basePos, onMatch) {
          for (let index = 0; index < chunk.length; index += 1) {
            const code = chunk.charCodeAt(index);
            let child = children.get(key(state, code));
            while (child === undefined && state !== ROOT) {
              state = fail[state]!;
              child = children.get(key(state, code));
            }
            state = child ?? ROOT;
            const length = longest[state]!;
            if (length > 0) onMatch(basePos + index + 1 - length, basePos + index + 1);
          }
          return pendingDepth[state]!;
        },
        reset() {
          state = ROOT;
        },
      };
    },
  };
}

let kmpTableBuilds = 0;

/** Total KMP prefix tables built in this process; used by tests to verify table reuse across streams. */
export function kmpTableBuildCount(): number {
  return kmpTableBuilds;
}

function prefixTable(pattern: string): Int32Array {
  kmpTableBuilds += 1;
  const fail = new Int32Array(pattern.length);
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    const code = pattern.charCodeAt(index);
    while (matched > 0 && pattern.charCodeAt(matched) !== code) matched = fail[matched - 1]!;
    if (pattern.charCodeAt(matched) === code) matched += 1;
    fail[index] = matched;
  }
  return fail;
}

/** Scans for each value in turn: memory stays at the text's length, time grows with values × text. */
function scanningMatcher(values: readonly string[]): SecretMatcher {
  const present = values.filter(Boolean);
  const count = present.length;
  const firstCodes = new Uint16Array(count);
  for (let j = 0; j < count; j += 1) firstCodes[j] = present[j]!.charCodeAt(0);
  // Lazily built KMP prefix tables shared across every stream created from this matcher.
  const sharedFails: Array<Int32Array | undefined> = new Array(count);
  const failFor = (index: number): Int32Array => {
    let table = sharedFails[index];
    if (!table) {
      table = prefixTable(present[index]!);
      sharedFails[index] = table;
    }
    return table;
  };
  return {
    empty: count === 0,
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
    createStream() {
      if (count === 0) return EMPTY_STREAM;
      const matched = new Int32Array(count);
      let pending = 0;

      return {
        feed(chunk, basePos, onMatch) {
          if (chunk.length === 0) return pending;
          // 128-bit ASCII presence bitset lets idle patterns skip non-matching chunks in O(1).
          let a0 = 0;
          let a1 = 0;
          let a2 = 0;
          let a3 = 0;
          for (let i = 0; i < chunk.length; i += 1) {
            const c = chunk.charCodeAt(i);
            if (c < 128) {
              if (c < 64) {
                if (c < 32) a0 |= 1 << c;
                else a1 |= 1 << (c - 32);
              } else if (c < 96) {
                a2 |= 1 << (c - 64);
              } else {
                a3 |= 1 << (c - 96);
              }
            }
          }
          let maxPending = 0;
          let chunkMatches: Array<[number, number]> | undefined;
          let matchedPatterns = 0;
          for (let j = 0; j < count; j += 1) {
            let m = matched[j]!;
            const first = firstCodes[j]!;
            if (m === 0 && first < 128) {
              const inChunk =
                first < 64
                  ? first < 32
                    ? (a0 & (1 << first)) !== 0
                    : (a1 & (1 << (first - 32))) !== 0
                  : first < 96
                    ? (a2 & (1 << (first - 64))) !== 0
                    : (a3 & (1 << (first - 96))) !== 0;
              if (!inChunk) continue;
            }
            const value = present[j]!;
            const length = value.length;
            let fail = sharedFails[j];
            let patternStart = -1;
            let patternEnd = -1;
            for (let i = 0; i < chunk.length; i += 1) {
              const code = chunk.charCodeAt(i);
              let matchStart = -1;
              let matchEnd = -1;
              if (m === 0) {
                if (code === first) {
                  if (length === 1) {
                    matchStart = basePos + i;
                    matchEnd = basePos + i + 1;
                  } else {
                    m = 1;
                  }
                }
              } else if (m === 1 && !fail) {
                if (code === value.charCodeAt(1)) {
                  if (length === 2) {
                    matchStart = basePos + i - 1;
                    matchEnd = basePos + i + 1;
                    m = first === code ? 1 : 0;
                  } else {
                    m = 2;
                  }
                } else {
                  m = code === first ? 1 : 0;
                }
              } else {
                if (!fail) fail = failFor(j);
                while (m > 0 && value.charCodeAt(m) !== code) m = fail[m - 1]!;
                if (value.charCodeAt(m) === code) m += 1;
                if (m === length) {
                  matchStart = basePos + i + 1 - length;
                  matchEnd = basePos + i + 1;
                  m = fail[length - 1]!;
                }
              }
              if (matchStart !== -1) {
                if (patternStart === -1) {
                  patternStart = matchStart;
                  patternEnd = matchEnd;
                } else if (matchStart < patternEnd) {
                  if (matchEnd > patternEnd) patternEnd = matchEnd;
                } else {
                  chunkMatches ??= [];
                  chunkMatches.push([patternStart, patternEnd]);
                  patternStart = matchStart;
                  patternEnd = matchEnd;
                }
              }
            }
            if (patternStart !== -1) {
              matchedPatterns += 1;
              chunkMatches ??= [];
              chunkMatches.push([patternStart, patternEnd]);
            }
            matched[j] = m;
            if (m > maxPending) maxPending = m;
          }
          if (chunkMatches) {
            if (matchedPatterns > 1 && chunkMatches.length > 1) {
              chunkMatches.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
            }
            for (const [start, end] of chunkMatches) onMatch(start, end);
          }
          pending = maxPending;
          return maxPending;
        },
        reset() {
          matched.fill(0);
          pending = 0;
        },
      };
    },
  };
}
