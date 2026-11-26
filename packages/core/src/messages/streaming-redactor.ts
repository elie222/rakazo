import type { SecretMatcher } from "./secret-matcher.js";
import { createSecretMatcher } from "./secret-matcher.js";

/** What redaction writes in place of a secret. */
export const REDACTED_MARKER = "[redacted]";

/** Shorter lines, or lines with spaces such as a key's BEGIN header, also appear in ordinary text. */
const MIN_SECRET_LINE_LENGTH = 16;

/** UTF-16 high surrogates (0xD800-0xDBFF) must be paired with a low surrogate for valid JSON. */
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function endsWithHighSurrogate(value: string): boolean {
  return value.length > 0 && isHighSurrogate(value.charCodeAt(value.length - 1));
}

/** NUL, a high surrogate with no low after it, or a low surrogate with no high before it. */
const UNSAFE_UTF16 = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Replace unpaired UTF-16 surrogates and NUL characters, which Postgres rejects
 * in json and text columns (command output and binary-ish tool results carry both).
 */
export function sanitizeUtf16ForJson(value: string): string {
  return value.replace(UNSAFE_UTF16, "\uFFFD");
}

/**
 * The values to hide for `secrets`: each value, and each long unspaced line of a multi-line value
 * such as a private key's body, since output that prints only some lines or joins them with
 * spaces (an unquoted `echo $KEY`) never contains the whole value.
 */
export function protectedValues(secrets: Iterable<string>): string[] {
  const values = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    values.add(secret);
    if (!/[\r\n]/.test(secret)) continue;
    for (const line of secret.split(/\r\n?|\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN_SECRET_LINE_LENGTH && !/\s/.test(trimmed)) values.add(trimmed);
    }
  }
  return [...values];
}

const streamMatchers = new WeakMap<readonly string[], { from: string[]; matcher: SecretMatcher }>();

function matcherForStream(secrets: readonly string[]): SecretMatcher {
  const cached = streamMatchers.get(secrets);
  if (
    cached &&
    cached.from.length === secrets.length &&
    cached.from.every((value, index) => value === secrets[index])
  ) {
    return cached.matcher;
  }
  const matcher = createSecretMatcher(protectedValues(secrets));
  streamMatchers.set(secrets, { from: [...secrets], matcher });
  return matcher;
}

/**
 * Incrementally redacts streamed text chunks against `secrets`.
 *
 * Only the active prefix that could still complete a match for a currently known secret is held
 * back between pushes. If the caller mutates `secrets` mid-stream, the newly registered values
 * protect everything starting inside the currently retained tail or pushed afterwards; text
 * already emitted before registration cannot be retroactively un-emitted.
 */
export function createStreamingRedactor(secrets: string[]) {
  let secretsSnapshot = [...secrets];
  let matcher = matcherForStream(secrets);
  let stream = matcher.createStream();
  // Held chunks in arrival order; chunks[chunkHead] starts at stream offset `chunkHeadPos`.
  let chunks: string[] = [];
  let chunkHead = 0;
  let chunkHeadPos = 0;
  let bufferStart = 0;
  let pos = 0;
  let coveredEnd = 0;
  let pendingDepth = 0;
  let pendingRanges: Array<[number, number]> = [];
  let pendingHead = 0;

  const sameSecrets = () => {
    if (secretsSnapshot.length !== secrets.length) return false;
    for (let index = 0; index < secretsSnapshot.length; index += 1) {
      if (secretsSnapshot[index] !== secrets[index]) return false;
    }
    return true;
  };

  const compactPending = () => {
    if (pendingHead === pendingRanges.length) {
      pendingRanges.length = 0;
      pendingHead = 0;
    } else if (pendingHead >= 64 && pendingHead * 2 >= pendingRanges.length) {
      pendingRanges = pendingRanges.slice(pendingHead);
      pendingHead = 0;
    }
  };

  const discardChunksBefore = (limit: number) => {
    while (chunkHead < chunks.length) {
      const length = chunks[chunkHead]!.length;
      if (chunkHeadPos + length > limit) break;
      chunkHeadPos += length;
      chunkHead += 1;
    }
    if (chunkHead === chunks.length) {
      chunks.length = 0;
      chunkHead = 0;
      chunkHeadPos = pos;
    } else if (chunkHead >= 256 && chunkHead * 2 >= chunks.length) {
      chunks = chunks.slice(chunkHead);
      chunkHead = 0;
    }
  };

  /** Reads up to `length` code units ending at `pos` (clamped at `bufferStart`) for rare promotions. */
  const readHeldTail = (length: number): string => {
    const want = Math.min(length, pos - bufferStart);
    if (want <= 0) return "";
    let remaining = want;
    const parts: string[] = [];
    for (let index = chunks.length - 1; index >= chunkHead && remaining > 0; index -= 1) {
      const piece = chunks[index]!;
      if (piece.length <= remaining) {
        parts.push(piece);
        remaining -= piece.length;
      } else {
        parts.push(piece.slice(piece.length - remaining));
        remaining = 0;
      }
    }
    parts.reverse();
    return parts.join("");
  };

  const recordMatch = (start: number, end: number) => {
    if (start < coveredEnd) {
      if (end > coveredEnd) {
        coveredEnd = end;
        while (pendingHead < pendingRanges.length && pendingRanges[pendingHead]![0] < coveredEnd) {
          const rangeEnd = pendingRanges[pendingHead]![1];
          if (rangeEnd > coveredEnd) coveredEnd = rangeEnd;
          pendingHead += 1;
        }
        compactPending();
      }
      return;
    }
    const last = pendingRanges.length > pendingHead ? pendingRanges.at(-1) : undefined;
    if (!last || start >= last[1]) {
      pendingRanges.push([start, end]);
      return;
    }
    let mergedStart = start;
    let mergedEnd = end;
    let first = pendingRanges.length;
    while (first > pendingHead && pendingRanges[first - 1]![1] > mergedStart) first -= 1;
    let stop = first;
    while (stop < pendingRanges.length && pendingRanges[stop]![0] < mergedEnd) {
      const [existingStart, existingEnd] = pendingRanges[stop]!;
      if (existingStart < mergedStart) mergedStart = existingStart;
      if (existingEnd > mergedEnd) mergedEnd = existingEnd;
      stop += 1;
    }
    pendingRanges.splice(first, stop - first, [mergedStart, mergedEnd]);
  };

  const syncSecrets = () => {
    if (sameSecrets()) return;
    secretsSnapshot = [...secrets];
    matcher = matcherForStream(secrets);
    stream = matcher.createStream();
    pendingRanges.length = 0;
    pendingHead = 0;
    pendingDepth = 0;
    if (pos <= bufferStart || matcher.empty) return;
    // Replay the retained tail as one contiguous string so any promotion inside `stream.feed`
    // has the full held prefix from `bufferStart` without needing an external tail callback.
    pendingDepth = stream.feed(readHeldTail(pos - bufferStart), bufferStart, recordMatch);
  };

  const drain = (final: boolean) => {
    // Only the active prefix length `pendingDepth` can start a match that completes in a later
    // chunk; everything before `cut` is final. A stretch reaching past `cut` emits now and keeps
    // its end in `coveredEnd`, so a later overlapping match extends the same placeholder.
    let cut = final ? pos : Math.max(bufferStart, pos - pendingDepth);
    let offset = coveredEnd;
    let output = "";
    let scanIdx = chunkHead;
    let scanPos = chunkHeadPos;
    const appendRange = (from: number, to: number) => {
      if (to <= from) return;
      while (scanIdx < chunks.length) {
        const piece = chunks[scanIdx]!;
        const pieceEnd = scanPos + piece.length;
        if (pieceEnd <= from) {
          scanPos = pieceEnd;
          scanIdx += 1;
          continue;
        }
        const sliceStart = Math.max(0, from - scanPos);
        const sliceEnd = Math.min(piece.length, to - scanPos);
        if (sliceEnd > sliceStart) {
          output +=
            sliceStart === 0 && sliceEnd === piece.length
              ? piece
              : piece.slice(sliceStart, sliceEnd);
        }
        if (pieceEnd <= to) {
          scanPos = pieceEnd;
          scanIdx += 1;
        } else {
          break;
        }
        if (scanPos >= to) break;
      }
    };
    while (pendingHead < pendingRanges.length) {
      const [start, end] = pendingRanges[pendingHead]!;
      if (start >= cut) break;
      if (start >= offset) {
        appendRange(offset, start);
        output += REDACTED_MARKER;
      }
      offset = Math.max(offset, end);
      pendingHead += 1;
    }
    compactPending();
    if (offset < cut) {
      appendRange(offset, cut);
      offset = cut;
    }
    // Hold a trailing high surrogate until the next chunk can supply its low half.
    if (!final && endsWithHighSurrogate(output)) {
      output = output.slice(0, -1);
      cut -= 1;
      offset = cut;
    }
    coveredEnd = Math.max(offset, cut);
    if (cut > bufferStart) {
      bufferStart = cut;
      discardChunksBefore(cut);
    }
    if (final) {
      stream.reset();
      pendingDepth = 0;
      pendingRanges.length = 0;
      pendingHead = 0;
    }
    return sanitizeUtf16ForJson(output);
  };

  return {
    push(chunk: string) {
      syncSecrets();
      if (chunk.length > 0) {
        if (!matcher.empty) {
          pendingDepth = stream.feed(chunk, pos, recordMatch, readHeldTail);
        }
        if (chunks.length === chunkHead) chunkHeadPos = pos;
        chunks.push(chunk);
        pos += chunk.length;
      }
      return drain(false);
    },
    finish() {
      syncSecrets();
      return drain(true);
    },
    /**
     * Drops what is held back without showing it, but keeps matching against it, so a value
     * split between the dropped text and the next chunk is still hidden.
     */
    skip() {
      coveredEnd = pos;
      pendingRanges.length = 0;
      pendingHead = 0;
    },
  };
}
