import { redactedRanges } from "@rakazo/core";
import { secretPrefixSuffixLength, secretSuffixPrefixLength } from "./agent-environment.js";

/**
 * Target characters retained per shell stream (stdout or stderr) after compaction, split evenly
 * between head and tail so initial headers and final errors survive. Each side also preserves the
 * longest secret overlap margin (`maxOverlap`) so registered secrets split across stdout and
 * stderr or straddling a cut still match whole; peak retention is
 * `SHELL_STREAM_MAX_CHARS + SHELL_STREAM_COMPACT_STEP + 2 * overlap`.
 */
export const SHELL_STREAM_MAX_CHARS = 128_000;
const SHELL_STREAM_HEAD_CHARS = Math.floor(SHELL_STREAM_MAX_CHARS / 2);
const SHELL_STREAM_TAIL_CHARS = SHELL_STREAM_MAX_CHARS - SHELL_STREAM_HEAD_CHARS;
const SHELL_STREAM_COMPACT_STEP = 32_000;
const MIN_MULTILINE_SECRET_LINE_LENGTH = 16;

function sameElements(previous: readonly string[], current: readonly string[]): boolean {
  if (previous.length !== current.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== current[index]) return false;
  }
  return true;
}

/**
 * Caches expanded cut-protection values and max secret length for a live `secrets` array,
 * rebuilding only when the array's elements change.
 */
export class SecretsCutSnapshot {
  private from: string[] = [];
  values: readonly string[] = [];
  valueSet: ReadonlySet<string> = new Set();
  maxLength = 0;
  maxOverlap = 0;
  private version = 0;

  constructor(readonly secrets: readonly string[]) {
    this.sync();
  }

  sync(): number {
    if (sameElements(this.from, this.secrets)) return this.version;
    this.from = [...this.secrets];
    const values = new Set<string>();
    let maxLength = 0;
    for (const secret of this.from) {
      if (!secret) continue;
      values.add(secret);
      if (secret.length > maxLength) maxLength = secret.length;
      if (!/[\r\n]/.test(secret)) continue;
      for (const line of secret.split(/\r\n?|\n/)) {
        const trimmed = line.trim();
        if (trimmed.length >= MIN_MULTILINE_SECRET_LINE_LENGTH && !/\s/.test(trimmed)) {
          values.add(trimmed);
        }
      }
    }
    this.valueSet = values;
    this.values = [...values];
    this.maxLength = maxLength;
    this.maxOverlap = maxLength > 1 ? maxLength - 1 : 0;
    this.version += 1;
    return this.version;
  }
}

function isSurrogateSplit(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function safeCutBefore(text: string, index: number): number {
  return isSurrogateSplit(text, index) ? index - 1 : index;
}

function safeCutAfter(text: string, index: number): number {
  return isSurrogateSplit(text, index) ? index + 1 : index;
}

/**
 * Copy a substring into a flat string so V8 can collect a much larger parent string that the
 * slice would otherwise keep alive. Preserves UTF-16 code units losslessly.
 */
function detachString(value: string): string {
  return value.length === 0 ? "" : Buffer.from(value, "utf16le").toString("utf16le");
}

/**
 * Expands a redacted boundary `from` rightward across secret matches using bounded windows around
 * the moving frontier instead of scanning all of `text`.
 */
function expandRangeRight(
  text: string,
  from: number,
  secrets: readonly string[],
  maxLen: number,
  includeTouching: boolean,
): number {
  let end = Math.min(from, text.length);
  if (end <= 0 || maxLen <= 0 || end >= text.length) return end;
  const margin = maxLen - 1;
  let step = maxLen;
  while (end < text.length) {
    const winStart = Math.max(0, end - margin);
    const winEnd = Math.min(text.length, end + step);
    let nextEnd = end;
    for (const [rangeStart, rangeEnd] of redactedRanges(text.slice(winStart, winEnd), secrets)) {
      const absStart = winStart + rangeStart;
      const absEnd = winStart + rangeEnd;
      if (includeTouching ? absStart > nextEnd : absStart >= nextEnd) break;
      if (absEnd > nextEnd) nextEnd = absEnd;
    }
    if (nextEnd === end) break;
    end = nextEnd;
    step = Math.min(text.length, step * 2);
  }
  return end;
}

/**
 * Expands a redacted boundary `from` leftward across secret matches using bounded windows around
 * the moving frontier instead of scanning all of `text`.
 */
function expandRangeLeft(
  text: string,
  from: number,
  secrets: readonly string[],
  maxLen: number,
  includeTouching: boolean,
): number {
  let start = Math.max(0, Math.min(from, text.length));
  if (start <= 0 || start >= text.length || maxLen <= 0) return start;
  const margin = maxLen - 1;
  let step = maxLen;
  while (start > 0) {
    const winStart = Math.max(0, start - step);
    const winEnd = Math.min(text.length, start + margin);
    const ranges = redactedRanges(text.slice(winStart, winEnd), secrets);
    let nextStart = start;
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
      const [rangeStart, rangeEnd] = ranges[index]!;
      const absStart = winStart + rangeStart;
      const absEnd = winStart + rangeEnd;
      if (includeTouching ? absEnd < nextStart : absEnd <= nextStart) break;
      if (absStart < nextStart) nextStart = absStart;
    }
    if (nextStart === start) break;
    start = nextStart;
    step = Math.min(text.length, step * 2);
  }
  return start;
}

/**
 * Finds the unique merged range inside `[cut - margin, cut + margin]` strictly straddling `cut`
 * (`start < cut < end`), or `undefined` when no secret crosses `cut`.
 */
function straddlingCutSpan(
  text: string,
  cut: number,
  secrets: readonly string[],
  maxLen: number,
): [number, number] | undefined {
  if (maxLen <= 1 || cut <= 0 || cut >= text.length) return undefined;
  const margin = maxLen - 1;
  const winStart = Math.max(0, cut - margin);
  const winEnd = Math.min(text.length, cut + margin);
  for (const [rangeStart, rangeEnd] of redactedRanges(text.slice(winStart, winEnd), secrets)) {
    const absStart = winStart + rangeStart;
    const absEnd = winStart + rangeEnd;
    if (absStart >= cut) break;
    if (absEnd > cut) return [absStart, absEnd];
  }
  return undefined;
}

function coveredBeforeCutWindow(
  text: string,
  cut: number,
  secrets: readonly string[],
  maxLen: number,
): number {
  const span = straddlingCutSpan(text, cut, secrets, maxLen);
  return span ? cut - expandRangeLeft(text, span[0], secrets, maxLen, false) : 0;
}

function coveredPastCutWindow(
  text: string,
  cut: number,
  secrets: readonly string[],
  maxLen: number,
): number {
  const span = straddlingCutSpan(text, cut, secrets, maxLen);
  return span ? expandRangeRight(text, span[1], secrets, maxLen, false) - cut : 0;
}

function coveredPastCutWithLeading(
  text: string,
  drop: number,
  leading: number,
  secrets: readonly string[],
  maxLen: number,
): number {
  if (leading > 0) {
    const leadingEnd = expandRangeRight(text, leading, secrets, maxLen, true);
    if (leadingEnd > drop) return leadingEnd - drop;
    if (leadingEnd === drop) return 0;
  }
  return coveredPastCutWindow(text, drop, secrets, maxLen);
}

/**
 * Rolling head+tail accumulator for one shell stream.
 *
 * Keeps both `head` and `tail` raw so secrets registered later or overlapping across chunks still
 * match whole and sign-in prompt detection sees raw output. Tracks `headRedactedSuffix` and
 * `tailRedactedPrefix` for secrets known at each drop cut, and conservatively masks matching
 * boundary fragments of secrets registered after a cut so no fragment of a cut-straddling secret
 * can leak unredacted.
 */
export class BoundedStreamBuffer {
  private head: string | undefined;
  private headRedactedSuffix = 0;
  private headCutSnapshot: ReadonlySet<string> = new Set();
  private headCutExtra: Set<string> | undefined;
  private headCutVersion = -1;
  private tail = "";
  private tailRedactedPrefix = 0;
  private tailCutSnapshot: ReadonlySet<string> = new Set();
  private tailCutExtra: Set<string> | undefined;
  private tailCutVersion = -1;
  private omittedChars = 0;

  constructor(private readonly cutSecrets: SecretsCutSnapshot) {}

  private get secrets(): readonly string[] {
    return this.cutSecrets.secrets;
  }

  get hasContent(): boolean {
    return this.head !== undefined || this.tail.length > 0;
  }

  get compacted(): boolean {
    return this.head !== undefined && this.omittedChars > 0;
  }

  rawHead(): string {
    return this.head ?? this.tail;
  }

  rawTail(): string {
    return this.tail;
  }

  headCutRedactedSuffix(): number {
    if (this.head === undefined) return 0;
    const trailing = this.effectiveHeadRedactedSuffix();
    if (trailing <= 0 || this.head.length === 0) return 0;
    const endCut = safeCutBefore(
      this.head,
      expandRangeLeft(
        this.head,
        Math.max(0, this.head.length - trailing),
        this.secrets,
        this.cutSecrets.maxLength,
        true,
      ),
    );
    return this.head.length - endCut;
  }

  tailCutRedactedPrefix(): number {
    if (this.head === undefined) return 0;
    const leading = this.effectiveTailRedactedPrefix();
    if (leading <= 0 || this.tail.length === 0) return 0;
    return safeCutAfter(
      this.tail,
      expandRangeRight(
        this.tail,
        Math.min(leading, this.tail.length),
        this.secrets,
        this.cutSecrets.maxLength,
        true,
      ),
    );
  }

  append(chunk: string): void {
    if (!chunk) return;
    this.tail += chunk;
    if (this.head === undefined) {
      if (this.tail.length <= SHELL_STREAM_MAX_CHARS + SHELL_STREAM_COMPACT_STEP) return;
      const version = this.cutSecrets.sync();
      const overlap = this.cutSecrets.maxOverlap;
      const keepHead = SHELL_STREAM_HEAD_CHARS + overlap;
      const keepTail = SHELL_STREAM_TAIL_CHARS + overlap;
      if (this.tail.length <= keepHead + keepTail + SHELL_STREAM_COMPACT_STEP) return;
      const headEnd = safeCutBefore(this.tail, keepHead);
      const tailStart = safeCutAfter(this.tail, this.tail.length - keepTail);
      const maxLen = this.cutSecrets.maxLength;
      this.head = detachString(this.tail.slice(0, headEnd));
      this.headRedactedSuffix = coveredBeforeCutWindow(this.tail, headEnd, this.secrets, maxLen);
      this.headCutSnapshot = this.cutSecrets.valueSet;
      this.headCutExtra = undefined;
      this.headCutVersion = version;
      this.tailRedactedPrefix = coveredPastCutWindow(this.tail, tailStart, this.secrets, maxLen);
      this.tailCutSnapshot = this.cutSecrets.valueSet;
      this.tailCutExtra = undefined;
      this.tailCutVersion = version;
      this.omittedChars = Math.max(0, tailStart - headEnd);
      this.tail = detachString(this.tail.slice(tailStart));
      return;
    }
    if (this.tail.length <= SHELL_STREAM_TAIL_CHARS + SHELL_STREAM_COMPACT_STEP) return;
    const version = this.cutSecrets.sync();
    const keepTail = SHELL_STREAM_TAIL_CHARS + this.cutSecrets.maxOverlap;
    if (this.tail.length <= keepTail + SHELL_STREAM_COMPACT_STEP) return;
    const drop = safeCutAfter(this.tail, this.tail.length - keepTail);
    const maxLen = this.cutSecrets.maxLength;
    const leading = this.effectiveTailRedactedPrefix();
    this.tailRedactedPrefix = coveredPastCutWithLeading(
      this.tail,
      drop,
      leading,
      this.secrets,
      maxLen,
    );
    this.tailCutSnapshot = this.cutSecrets.valueSet;
    this.tailCutExtra = undefined;
    this.tailCutVersion = version;
    this.omittedChars += drop;
    this.tail = detachString(this.tail.slice(drop));
  }

  private effectiveHeadRedactedSuffix(): number {
    if (!this.head) return this.headRedactedSuffix;
    const version = this.cutSecrets.sync();
    if (this.headCutVersion === version) return this.headRedactedSuffix;
    for (const value of this.cutSecrets.values) {
      if (value.length < 2 || this.headCutSnapshot.has(value) || this.headCutExtra?.has(value)) {
        continue;
      }
      // Head is immutable after compaction, so each newly registered secret is scanned once.
      this.headCutExtra ??= new Set();
      this.headCutExtra.add(value);
      this.headRedactedSuffix = Math.max(
        this.headRedactedSuffix,
        secretPrefixSuffixLength(this.head, value),
      );
    }
    this.headCutVersion = version;
    return this.headRedactedSuffix;
  }

  private effectiveTailRedactedPrefix(): number {
    let prefix = this.tailRedactedPrefix;
    if (!this.tail) return prefix;
    const version = this.cutSecrets.sync();
    if (this.tailCutVersion === version) return prefix;
    let allSettled = true;
    for (const value of this.cutSecrets.values) {
      if (value.length < 2 || this.tailCutSnapshot.has(value) || this.tailCutExtra?.has(value)) {
        continue;
      }
      const matched = secretSuffixPrefixLength(this.tail, value);
      if (this.tail.length >= value.length - 1) {
        this.tailCutExtra ??= new Set();
        this.tailCutExtra.add(value);
        this.tailRedactedPrefix = Math.max(this.tailRedactedPrefix, matched);
      } else {
        allSettled = false;
      }
      prefix = Math.max(prefix, matched);
    }
    if (allSettled) this.tailCutVersion = version;
    return prefix;
  }

  recentTail(chars: number): string {
    return this.tail.length <= chars ? this.tail : this.tail.slice(-chars);
  }

  text(mask?: { redactLeading?: number; redactTrailing?: number }): string {
    const redactLeading = mask?.redactLeading ?? 0;
    const redactTrailing = mask?.redactTrailing ?? 0;
    if (this.head === undefined) {
      return this.maskSegment(this.tail, redactLeading, redactTrailing);
    }
    const headView = this.maskSegment(this.head, redactLeading, this.effectiveHeadRedactedSuffix());
    const tailView = this.maskSegment(
      this.tail,
      this.effectiveTailRedactedPrefix(),
      redactTrailing,
    );
    if (this.omittedChars <= 0) return `${headView}${tailView}`;
    return `${headView}\n[... ${this.omittedChars} characters omitted ...]\n${tailView}`;
  }

  private maskSegment(segment: string, leading: number, trailing: number): string {
    if (leading <= 0 && trailing <= 0) return segment;
    if (segment.length === 0) return "";
    this.cutSecrets.sync();
    const maxLen = this.cutSecrets.maxLength;
    const startCut =
      leading > 0
        ? safeCutAfter(
            segment,
            expandRangeRight(
              segment,
              Math.min(leading, segment.length),
              this.secrets,
              maxLen,
              true,
            ),
          )
        : 0;
    const endCut =
      trailing > 0
        ? safeCutBefore(
            segment,
            expandRangeLeft(
              segment,
              Math.max(0, segment.length - trailing),
              this.secrets,
              maxLen,
              true,
            ),
          )
        : segment.length;
    if (startCut >= endCut) return "[redacted]";
    const prefix = leading > 0 ? "[redacted]" : "";
    const suffix = trailing > 0 ? "[redacted]" : "";
    return `${prefix}${segment.slice(startCut, endCut)}${suffix}`;
  }
}
