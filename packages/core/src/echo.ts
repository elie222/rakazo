/** Above this length, require matched words to cluster in a compact span rather than across turns. */
const MAX_ECHO_WORDS = 12;
/** Upper bound on transcripts checked for long echoes so multi-minute clips stay bounded. */
const MAX_LONG_ECHO_WORDS = 160;
/** Fewer matched words than this is coincidence, not the speaker leaking into the mic. */
const MIN_ECHO_WORDS = 3;
const ECHO_MATCH_RATIO = 0.6;
/** Compactness multiplier for matching echoed transcripts longer than MAX_ECHO_WORDS. */
const LONG_ECHO_SPAN_FACTOR = 1.5;

const CONTRACTIONS: Record<string, string> = {
  m: "am",
  re: "are",
  s: "is",
  ll: "will",
  ve: "have",
  d: "would",
};

/** Dictation writes out what speech contracts, so "I'm" must compare equal to "I am". */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/n['’]t\b/g, " not")
    .replace(/['’](m|re|s|ll|ve|d)\b/g, (_match, tail: string) => ` ${CONTRACTIONS[tail]}`)
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True when a transcript is the microphone catching the reply that just played.
 *
 * `threshold` is the share of heard words that must match; lower it while audio is
 * still playing, when far more of what the mic picks up is the speaker.
 *
 * ponytail: in-order word overlap, no acoustics. It can still drop a short genuine
 * turn that quotes the reply back; move to an energy/echo-cancellation signal from
 * the audio graph if that shows up in practice.
 */
export function isEchoOfSpeech(
  heard: string,
  spoken: string,
  threshold = ECHO_MATCH_RATIO,
): boolean {
  const heardWords = words(heard);
  const spokenWords = words(spoken);
  if (!heardWords.length || !spokenWords.length) return false;
  if (heardWords.length === 2) {
    return spokenWords.some(
      (word, i) => word === heardWords[0] && spokenWords[i + 1] === heardWords[1],
    );
  }
  if (heardWords.length > MAX_ECHO_WORDS) {
    // Keep playback barge-in (looser thresholds < ECHO_MATCH_RATIO) accepting long interruptions.
    if (threshold < ECHO_MATCH_RATIO || heardWords.length > MAX_LONG_ECHO_WORDS) return false;
    return hasCompactInOrderMatch(heardWords, spokenWords, threshold);
  }
  let cursor = 0;
  let matched = 0;
  for (const word of heardWords) {
    const at = spokenWords.indexOf(word, cursor);
    if (at === -1) continue;
    matched += 1;
    cursor = at + 1;
  }
  if (matched < MIN_ECHO_WORDS) return false;
  return matched / heardWords.length >= threshold;
}

/**
 * Matches longer transcripts (MAX_ECHO_WORDS < len <= MAX_LONG_ECHO_WORDS) only when enough
 * heard words appear in order inside a single compact window of `spokenWords`. Slides an O(S)
 * word-count filter first and only runs bounded 1D LCS on candidate windows.
 */
function hasCompactInOrderMatch(
  heardWords: readonly string[],
  spokenWords: readonly string[],
  threshold: number,
): boolean {
  const required = Math.max(MIN_ECHO_WORDS, Math.ceil(heardWords.length * threshold));
  if (spokenWords.length < required) return false;
  const needed = new Map<string, number>();
  for (const word of heardWords) {
    needed.set(word, (needed.get(word) ?? 0) + 1);
  }
  const windowSize = Math.min(
    spokenWords.length,
    Math.ceil(heardWords.length * LONG_ECHO_SPAN_FACTOR),
  );
  const have = new Map<string, number>();
  let overlap = 0;
  const addWord = (word: string) => {
    const want = needed.get(word);
    if (!want) return;
    const count = (have.get(word) ?? 0) + 1;
    have.set(word, count);
    if (count <= want) overlap += 1;
  };
  const removeWord = (word: string) => {
    const want = needed.get(word);
    if (!want) return;
    const count = have.get(word) ?? 0;
    if (count <= want) overlap -= 1;
    have.set(word, count - 1);
  };
  for (let i = 0; i < windowSize; i += 1) {
    const word = spokenWords[i];
    if (word) addWord(word);
  }
  const maxStart = spokenWords.length - windowSize;
  for (let start = 0; start <= maxStart; start += 1) {
    if (overlap >= required) {
      if (
        lcsLengthInWindow(heardWords, spokenWords, start, start + windowSize, required) >= required
      ) {
        return true;
      }
    }
    if (start < maxStart) {
      const leaving = spokenWords[start];
      const entering = spokenWords[start + windowSize];
      if (leaving) removeWord(leaving);
      if (entering) addWord(entering);
    }
  }
  return false;
}

function lcsLengthInWindow(
  heardWords: readonly string[],
  spokenWords: readonly string[],
  start: number,
  end: number,
  required: number,
): number {
  const m = heardWords.length;
  const dp = new Uint16Array(m + 1);
  let best = 0;
  for (let s = start; s < end; s += 1) {
    const word = spokenWords[s];
    let prevDiag = 0;
    for (let h = 1; h <= m; h += 1) {
      const saved = dp[h] ?? 0;
      if (word === heardWords[h - 1]) {
        const next = prevDiag + 1;
        dp[h] = next;
        if (next > best) {
          best = next;
          if (best >= required) return best;
        }
      } else {
        const left = dp[h - 1] ?? 0;
        if (left > saved) dp[h] = left;
      }
      prevDiag = saved;
    }
  }
  return best;
}

/** How long a spoken line can still come back through the microphone. */
const ECHO_MEMORY_MS = 15_000;
/** More than one call's worth of turns inside the window; older ones are dropped. */
const ECHO_MEMORY_MAX = 16;

/**
 * Every line the speaker played recently. Matching only against the last one misses
 * the common case: by the time the microphone delivers an echo, a newer reply has
 * already taken that slot.
 */
export class SpokenMemory {
  private entries: { text: string; at: number }[] = [];

  remember(text: string, now = Date.now()): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = this.entries.at(-1);
    if (last?.text === trimmed) last.at = now;
    else this.entries.push({ text: trimmed, at: now });
    this.prune(now);
  }

  clear(): void {
    this.entries = [];
  }

  /**
   * ponytail: one in-order match against the window's lines joined in order. That
   * subsumes every consecutive run inside it, so a heard line spanning two replies
   * matches without comparing each pair — at the cost of also matching words picked
   * from lines further apart. Compare runs pairwise if that drops real turns.
   */
  isEcho(heard: string, threshold = ECHO_MATCH_RATIO, now = Date.now()): boolean {
    this.prune(now);
    if (words(heard).length > MAX_ECHO_WORDS) {
      // Long transcripts are matched against individual replies so words across reply boundaries
      // cannot combine to swallow a genuine long turn.
      return this.entries.some((entry) => isEchoOfSpeech(heard, entry.text, threshold));
    }
    return isEchoOfSpeech(heard, this.entries.map((entry) => entry.text).join(". "), threshold);
  }

  private prune(now: number): void {
    const cutoff = now - ECHO_MEMORY_MS;
    this.entries = this.entries.filter((entry) => entry.at >= cutoff).slice(-ECHO_MEMORY_MAX);
  }
}

export const spokenMemory = new SpokenMemory();
