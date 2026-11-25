import { setImmediate } from "node:timers/promises";
import type { ProcessEvent } from "@rakazo/adapter-kit";
import { redactedRanges, redactSecrets } from "@rakazo/core";
import { automated } from "../../messaging/automated-messages.prompt.js";
import { shortenPlainText } from "../../runtime/context/context-selection.js";
import { TOOL_RESULT_TEXT_LIMIT } from "../../runtime/pi/pi-runtime-limits.js";
import {
  redactShellStreams,
  secretPrefixSuffixLength,
  secretSuffixPrefixLength,
} from "./agent-environment.js";

/**
 * Device-code logins print a code and then wait. Once that output goes quiet,
 * return it while the process is still running so the bot can show the code.
 * Fast commands that exit inside this window are unchanged.
 */
export const SHELL_STREAM_IDLE_MS = 1_000;

/**
 * Other output often pauses briefly (a header before an API call), so wait longer before
 * returning a command that is still running, such as one waiting on a prompt.
 */
const SHELL_STREAM_QUIET_MS = 10_000;

// A device-code prompt prints a link and a code together. A link alone is ordinary progress
// output (`Fetching https://...`), so it does not end the wait. Device codes are usually groups
// such as ABCD-1234 or 1234-5678, or one token mixing letters and digits such as FZ8Q4X8BJ; a
// word (ERROR), a number or a short error code (E404) is not counted. A code in another shape
// returns after the longer wait.
const SIGN_IN_LINK = /https?:\/\/\S/;
const ONE_TIME_CODE =
  /\b[Cc]ode\b[\s:"'`]*(?:is\s+)?(?:[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+|(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{6,})\b/;
// A prompt is the latest output, so only the end of each stream is checked, which keeps long
// logs cheap. The link and the code may be on different streams.
const SIGN_IN_PROMPT_SCAN_CHARS = 4_000;

/**
 * Target characters retained per shell stream (stdout or stderr) after compaction, split evenly
 * between head and tail so initial headers and final errors survive. Each side also preserves the
 * longest secret overlap margin (`maxSecretOverlap(secrets)`) so registered secrets split across
 * stdout and stderr or straddling a cut still match whole; peak retention is
 * `SHELL_STREAM_MAX_CHARS + SHELL_STREAM_COMPACT_STEP + 2 * overlap`.
 */
export const SHELL_STREAM_MAX_CHARS = 128_000;
const SHELL_STREAM_HEAD_CHARS = Math.floor(SHELL_STREAM_MAX_CHARS / 2);
const SHELL_STREAM_TAIL_CHARS = SHELL_STREAM_MAX_CHARS - SHELL_STREAM_HEAD_CHARS;
const SHELL_STREAM_COMPACT_STEP = 32_000;
const MIN_MULTILINE_SECRET_LINE_LENGTH = 16;

function protectedCutValues(secrets: readonly string[]): string[] {
  const values = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    values.add(secret);
    if (!/[\r\n]/.test(secret)) continue;
    for (const line of secret.split(/\r\n?|\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= MIN_MULTILINE_SECRET_LINE_LENGTH && !/\s/.test(trimmed)) {
        values.add(trimmed);
      }
    }
  }
  return [...values];
}

function maxSecretOverlap(secrets: readonly string[]): number {
  let max = 0;
  for (const secret of secrets) {
    if (secret.length > max) max = secret.length;
  }
  return max > 1 ? max - 1 : 0;
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

function mergeLeadingRedactedRange(
  ranges: ReadonlyArray<[number, number]>,
  leadingEnd: number,
): Array<[number, number]> {
  if (leadingEnd <= 0) return [...ranges];
  let end = leadingEnd;
  let index = 0;
  while (index < ranges.length && ranges[index]![0] <= end) {
    end = Math.max(end, ranges[index]![1]);
    index += 1;
  }
  return [[0, end], ...ranges.slice(index)];
}

function mergeTrailingRedactedRange(
  ranges: ReadonlyArray<[number, number]>,
  trailingStart: number,
  length: number,
): number {
  let start = trailingStart;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const [rangeStart, rangeEnd] = ranges[index]!;
    if (rangeEnd < start) break;
    if (rangeStart < start) start = rangeStart;
  }
  return Math.min(start, length);
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
class BoundedStreamBuffer {
  private head: string | undefined;
  private headRedactedSuffix = 0;
  private headCutSecrets = new Set<string>();
  private tail = "";
  private tailRedactedPrefix = 0;
  private tailCutSecrets = new Set<string>();
  private omittedChars = 0;

  constructor(private readonly secrets: readonly string[]) {}

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

  append(chunk: string): void {
    if (!chunk) return;
    this.tail += chunk;
    const overlap = maxSecretOverlap(this.secrets);
    const keepHead = SHELL_STREAM_HEAD_CHARS + overlap;
    const keepTail = SHELL_STREAM_TAIL_CHARS + overlap;
    if (this.head === undefined) {
      if (this.tail.length <= keepHead + keepTail + SHELL_STREAM_COMPACT_STEP) {
        return;
      }
      const ranges = redactedRanges(this.tail, this.secrets);
      const headEnd = safeCutBefore(this.tail, keepHead);
      const tailStart = safeCutAfter(this.tail, this.tail.length - keepTail);
      const cutSnapshot = new Set(protectedCutValues(this.secrets));
      this.head = detachString(this.tail.slice(0, headEnd));
      this.headRedactedSuffix = this.coveredBeforeCut(ranges, headEnd);
      this.headCutSecrets = cutSnapshot;
      this.tailRedactedPrefix = this.coveredPastCut(ranges, tailStart);
      this.tailCutSecrets = new Set(cutSnapshot);
      this.omittedChars = Math.max(0, tailStart - headEnd);
      this.tail = detachString(this.tail.slice(tailStart));
      return;
    }
    if (this.tail.length <= keepTail + SHELL_STREAM_COMPACT_STEP) return;
    const ranges = mergeLeadingRedactedRange(
      redactedRanges(this.tail, this.secrets),
      this.effectiveTailRedactedPrefix(),
    );
    const drop = safeCutAfter(this.tail, this.tail.length - keepTail);
    this.tailRedactedPrefix = this.coveredPastCut(ranges, drop);
    this.tailCutSecrets = new Set(protectedCutValues(this.secrets));
    this.omittedChars += drop;
    this.tail = detachString(this.tail.slice(drop));
  }

  private coveredBeforeCut(ranges: ReadonlyArray<[number, number]>, cut: number): number {
    for (const [start, end] of ranges) {
      if (start >= cut) break;
      if (end > cut) return cut - start;
    }
    return 0;
  }

  private coveredPastCut(ranges: ReadonlyArray<[number, number]>, cut: number): number {
    for (const [start, end] of ranges) {
      if (start >= cut) break;
      if (end > cut) return end - cut;
    }
    return 0;
  }

  private effectiveHeadRedactedSuffix(): number {
    if (!this.head) return this.headRedactedSuffix;
    for (const value of protectedCutValues(this.secrets)) {
      if (value.length < 2 || this.headCutSecrets.has(value)) continue;
      // Head is immutable after compaction, so each newly registered secret is scanned once.
      this.headCutSecrets.add(value);
      this.headRedactedSuffix = Math.max(
        this.headRedactedSuffix,
        secretPrefixSuffixLength(this.head, value),
      );
    }
    return this.headRedactedSuffix;
  }

  private effectiveTailRedactedPrefix(): number {
    let prefix = this.tailRedactedPrefix;
    if (!this.tail) return prefix;
    for (const value of protectedCutValues(this.secrets)) {
      if (value.length < 2 || this.tailCutSecrets.has(value)) continue;
      const matched = secretSuffixPrefixLength(this.tail, value);
      if (this.tail.length >= value.length - 1) {
        this.tailCutSecrets.add(value);
        this.tailRedactedPrefix = Math.max(this.tailRedactedPrefix, matched);
      }
      prefix = Math.max(prefix, matched);
    }
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
    const ranges = redactedRanges(segment, this.secrets);
    const startCut =
      leading > 0
        ? safeCutAfter(
            segment,
            mergeLeadingRedactedRange(ranges, Math.min(leading, segment.length))[0]![1],
          )
        : 0;
    const endCut =
      trailing > 0
        ? safeCutBefore(
            segment,
            mergeTrailingRedactedRange(
              ranges,
              Math.max(0, segment.length - trailing),
              segment.length,
            ),
          )
        : segment.length;
    if (startCut >= endCut) return "[redacted]";
    const prefix = leading > 0 ? "[redacted]" : "";
    const suffix = trailing > 0 ? "[redacted]" : "";
    return `${prefix}${segment.slice(startCut, endCut)}${suffix}`;
  }
}

function kmpPrefixTable(pattern: string, length = pattern.length): Int32Array {
  const lps = new Int32Array(length);
  for (let i = 1, j = 0; i < length; i += 1) {
    const ch = pattern.charCodeAt(i);
    while (j > 0 && pattern.charCodeAt(j) !== ch) j = lps[j - 1]!;
    if (pattern.charCodeAt(j) === ch) j += 1;
    lps[i] = j;
  }
  return lps;
}

/** Calls `onStart(pos)` for every `pos` in `[minStart, maxStartExclusive)` where `haystack` contains `needle`. */
function kmpSearchStarts(
  haystack: string,
  needle: string,
  minStart: number,
  maxStartExclusive: number,
  onStart: (pos: number) => void,
): void {
  const m = needle.length;
  if (m === 0 || minStart >= maxStartExclusive) return;
  const end = Math.min(haystack.length, maxStartExclusive + m - 1);
  if (end - minStart < m) return;
  const lps = kmpPrefixTable(needle);
  let j = 0;
  for (let i = minStart; i < end; i += 1) {
    const ch = haystack.charCodeAt(i);
    while (j > 0 && needle.charCodeAt(j) !== ch) j = lps[j - 1]!;
    if (needle.charCodeAt(j) === ch) j += 1;
    if (j === m) {
      const pos = i - m + 1;
      if (pos >= minStart && pos < maxStartExclusive) onStart(pos);
      j = lps[j - 1]!;
    }
  }
}

/** Bitmask `mask[len] === 1` for every `1 <= len <= maxLen` where `secret.slice(0, len)` is a suffix of `text`. */
function secretPrefixSuffixBorders(text: string, secret: string, maxLen: number): Uint8Array {
  const mask = new Uint8Array(maxLen + 1);
  const limit = Math.min(maxLen, text.length, secret.length - 1);
  if (limit <= 0) return mask;
  const lps = kmpPrefixTable(secret, limit);
  const start = text.length - limit;
  let matched = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    while (matched > 0 && secret.charCodeAt(matched) !== ch) matched = lps[matched - 1]!;
    if (secret.charCodeAt(matched) === ch) matched += 1;
  }
  for (let len = matched; len > 0; len = lps[len - 1]!) {
    mask[len] = 1;
  }
  return mask;
}

/** Bitmask `mask[len] === 1` for every `1 <= len <= maxLen` where `secret.slice(secret.length - len)` is a prefix of `text`. */
function secretSuffixPrefixBorders(text: string, secret: string, maxLen: number): Uint8Array {
  const mask = new Uint8Array(maxLen + 1);
  const last = secret.length - 1;
  const limit = Math.min(maxLen, text.length, last);
  if (limit <= 0) return mask;
  const lps = new Int32Array(limit);
  for (let i = 1, j = 0; i < limit; i += 1) {
    const ch = secret.charCodeAt(last - i);
    while (j > 0 && secret.charCodeAt(last - j) !== ch) j = lps[j - 1]!;
    if (secret.charCodeAt(last - j) === ch) j += 1;
    lps[i] = j;
  }
  let matched = 0;
  for (let i = limit - 1; i >= 0; i -= 1) {
    const ch = text.charCodeAt(i);
    while (matched > 0 && secret.charCodeAt(last - matched) !== ch) matched = lps[matched - 1]!;
    if (secret.charCodeAt(last - matched) === ch) matched += 1;
  }
  for (let len = matched; len > 0; len = lps[len - 1]!) {
    mask[len] = 1;
  }
  return mask;
}

function redactCompactedStreams(
  stdout: BoundedStreamBuffer,
  stderr: BoundedStreamBuffer,
  secrets: string[],
  withholdPartial: boolean,
): ShellCommandSnapshot {
  let stdoutTrailing = 0;
  let stderrLeading = 0;
  if (stdout.compacted || stderr.compacted) {
    const stdoutTail = stdout.rawTail();
    const stderrHead = stderr.rawHead();
    if (stdoutTail.length > 0 && stderrHead.length > 0) {
      for (const secret of protectedCutValues(secrets)) {
        if (secret.length < 2) continue;
        const needStdoutScan = stdout.compacted && secret.length > stdoutTail.length;
        const needStderrScan = stderr.compacted && secret.length > stderrHead.length;
        const checkBothCompacted =
          needStdoutScan && needStderrScan && secret.length > stdoutTail.length + stderrHead.length;
        let stdoutMatchEnds: Uint8Array | undefined;
        if (needStdoutScan) {
          const maxSuffix = Math.min(stderrHead.length, secret.length - stdoutTail.length - 1);
          const validSuffixes = secretSuffixPrefixBorders(stderrHead, secret, maxSuffix);
          if (checkBothCompacted) stdoutMatchEnds = new Uint8Array(secret.length);
          kmpSearchStarts(secret, stdoutTail, 1, secret.length - stdoutTail.length, (pos) => {
            const end = pos + stdoutTail.length;
            const suffixLen = secret.length - end;
            if (suffixLen <= maxSuffix && validSuffixes[suffixLen]) {
              stdoutTrailing = stdoutTail.length;
              stderrLeading = Math.max(stderrLeading, suffixLen);
            }
            if (stdoutMatchEnds && end + stderrHead.length < secret.length) {
              stdoutMatchEnds[end] = 1;
            }
          });
        }
        if (needStderrScan) {
          const maxPrefix = Math.min(stdoutTail.length, secret.length - stderrHead.length - 1);
          const validPrefixes = secretPrefixSuffixBorders(stdoutTail, secret, maxPrefix);
          kmpSearchStarts(secret, stderrHead, 1, secret.length - stderrHead.length, (pos) => {
            if (pos <= maxPrefix && validPrefixes[pos]) {
              stdoutTrailing = Math.max(stdoutTrailing, pos);
              stderrLeading = stderrHead.length;
            }
            if (stdoutMatchEnds?.[pos]) {
              stdoutTrailing = stdoutTail.length;
              stderrLeading = stderrHead.length;
            }
          });
        }
      }
    }
  }
  return redactShellStreams(
    {
      stdout: stdout.text(stdoutTrailing > 0 ? { redactTrailing: stdoutTrailing } : undefined),
      stderr: stderr.text(stderrLeading > 0 ? { redactLeading: stderrLeading } : undefined),
    },
    secrets,
    { withholdPartial },
  );
}

function showsSignInPrompt(stdoutTail: string, stderrTail: string): boolean {
  const recent = [stdoutTail, stderrTail];
  return (
    recent.some((stream) => SIGN_IN_LINK.test(stream)) &&
    recent.some((stream) => ONE_TIME_CODE.test(stream))
  );
}

export const SHELL_STILL_RUNNING_NOTICE =
  "Still running. Tell the user any one-time code or sign-in URL in the output.";

export interface ShellCommandSnapshot {
  stdout: string;
  stderr: string;
}

export interface FinishedShellCommand extends ShellCommandSnapshot {
  code: number;
}

export interface RunningShellCommand extends ShellCommandSnapshot {
  code: null;
  running: true;
}

export type ShellCommandResult = FinishedShellCommand | RunningShellCommand;

export function isRunningShellCommand(result: unknown): result is RunningShellCommand {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { running?: unknown }).running === true &&
    (result as { code?: unknown }).code === null
  );
}

export function formatFinishedShellCommand(result: FinishedShellCommand): string {
  // Delivered in the user's role after the turn, so marked as automated: models took
  // finished console output for the user replying.
  const parts = [automated("Shell command finished."), `exit code: ${result.code}`];
  if (result.stdout) parts.push(`stdout:\n${keepHeadAndTail(result.stdout)}`);
  if (result.stderr) parts.push(`stderr:\n${keepHeadAndTail(result.stderr)}`);
  return parts.join("\n");
}

// Build and install failures print last, so keep the tail as well as the head.
function keepHeadAndTail(text: string): string {
  return text.length > TOOL_RESULT_TEXT_LIMIT
    ? shortenPlainText(text, TOOL_RESULT_TEXT_LIMIT)
    : text;
}

/**
 * After the turn that first saw a still-running shell, hand the bot the final output of
 * commands that have exited. The turn that received the live output is skipped so the bot
 * can relay a device code before the process ends.
 *
 * A turn that called tools takes only the commands that already exited: the bot is still
 * working, and waiting here would also hold back the person's messages until the sandbox
 * command timeout. A turn that would otherwise end the run waits for the rest. A turn that
 * ended in a model error or an abort makes no further request, so nothing waits on it.
 */
export async function deliverFinishedShells(
  deliver: (text: string) => void,
  pending: Array<Promise<FinishedShellCommand>>,
  turn: {
    message?: { stopReason?: string };
    toolResults: Array<{ toolName?: string; details?: unknown }>;
  },
  signal?: AbortSignal,
): Promise<void> {
  if (pending.length === 0 || turnReturnedRunningShell(turn)) return;
  if (turn.message?.stopReason === "error" || turn.message?.stopReason === "aborted") return;
  const batch =
    turn.toolResults.length > 0 ? await takeExited(pending) : pending.splice(0, pending.length);
  const results = await Promise.all(batch.map((completion) => finishOrAbort(completion, signal)));
  const texts = results.filter((result): result is FinishedShellCommand => result !== undefined);
  if (texts.length === 0) return;
  deliver(texts.map((result) => formatFinishedShellCommand(result)).join("\n\n"));
}

/** Remove and return the commands that already exited, leaving the rest pending. */
async function takeExited(
  pending: Array<Promise<FinishedShellCommand>>,
): Promise<Array<Promise<FinishedShellCommand>>> {
  const exited = new Set<Promise<FinishedShellCommand>>();
  for (const completion of pending) {
    const mark = () => exited.add(completion);
    void completion.then(mark, mark);
  }
  // A settled promise runs its callbacks before the next macrotask; a running one does not.
  await setImmediate();
  const taken = pending.filter((completion) => exited.has(completion));
  pending.splice(0, pending.length, ...pending.filter((completion) => !exited.has(completion)));
  return taken;
}

function turnReturnedRunningShell(turn: {
  toolResults: Array<{ toolName?: string; details?: unknown }>;
}): boolean {
  return turn.toolResults.some(
    (result) =>
      (result.toolName === "shell" || result.toolName === "user_computer_shell") &&
      isRunningShellCommand(result.details),
  );
}

async function finishOrAbort(
  completion: Promise<FinishedShellCommand>,
  signal?: AbortSignal,
): Promise<FinishedShellCommand | undefined> {
  if (signal?.aborted) return undefined;
  const settled = completion.then(
    (result) => result,
    (error: unknown) => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : "command failed",
      code: 1,
    }),
  );
  if (!signal) return settled;
  return Promise.race([
    settled,
    new Promise<undefined>((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      signal.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
  ]);
}

/**
 * Read a command stream. When output arrives and then stays quiet, return it before exit
 * and keep collecting the rest on `completion`. A sign-in prompt returns after `idleMs`,
 * other output after `quietMs`.
 */
export async function observeShellCommand(
  events: AsyncIterable<ProcessEvent>,
  options: {
    secrets: string[];
    idleMs?: number;
    quietMs?: number;
    onOutput?: (snapshot: ShellCommandSnapshot) => void;
    /** Minimum interval between live `onOutput` snapshots; 0 emits on every chunk. */
    onOutputIntervalMs?: number;
  },
): Promise<{
  result: ShellCommandResult;
  completion?: Promise<FinishedShellCommand>;
}> {
  const idleMs = options.idleMs ?? SHELL_STREAM_IDLE_MS;
  const quietMs = options.quietMs ?? SHELL_STREAM_QUIET_MS;
  const onOutputIntervalMs = options.onOutputIntervalMs ?? 0;
  const stdout = new BoundedStreamBuffer(options.secrets);
  const stderr = new BoundedStreamBuffer(options.secrets);
  let code: number | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onOutputTimer: ReturnType<typeof setTimeout> | undefined;
  let hasEmittedOutput = false;
  let lastOnOutputAt = 0;
  let resolveIdle: ((reason: "idle" | "done") => void) | undefined;
  const idlePromise = new Promise<"idle" | "done">((resolve) => {
    resolveIdle = resolve;
  });

  const redact = (withholdPartial: boolean): ShellCommandSnapshot =>
    redactCompactedStreams(stdout, stderr, options.secrets, withholdPartial);

  const clearIdle = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const clearOnOutputTimer = () => {
    if (onOutputTimer) clearTimeout(onOutputTimer);
    onOutputTimer = undefined;
  };

  const emitLiveOutput = () => {
    clearOnOutputTimer();
    if (!options.onOutput || finished) return;
    hasEmittedOutput = true;
    lastOnOutputAt = Date.now();
    const published = redact(true);
    try {
      options.onOutput(published);
    } catch {
      // Live output is a view. A failed update must not kill the command.
    }
  };

  const scheduleLiveOutput = () => {
    if (!options.onOutput) return;
    if (onOutputIntervalMs <= 0) {
      emitLiveOutput();
      return;
    }
    const elapsed = Date.now() - lastOnOutputAt;
    if (!hasEmittedOutput || elapsed >= onOutputIntervalMs) {
      emitLiveOutput();
      return;
    }
    if (!onOutputTimer) {
      onOutputTimer = setTimeout(emitLiveOutput, Math.max(0, onOutputIntervalMs - elapsed));
    }
  };

  const armIdle = (waitMs: number) => {
    clearIdle();
    if (waitMs <= 0) {
      resolveIdle?.("idle");
      return;
    }
    timer = setTimeout(() => resolveIdle?.("idle"), waitMs);
  };

  const done = (async (): Promise<FinishedShellCommand> => {
    try {
      for await (const event of events) {
        if (event.type === "stdout") stdout.append(event.data);
        else if (event.type === "stderr") stderr.append(event.data);
        else if (event.type === "exit") {
          code = event.code;
          break;
        } else continue;
        scheduleLiveOutput();
        if (stdout.hasContent || stderr.hasContent) {
          armIdle(
            showsSignInPrompt(
              stdout.recentTail(SIGN_IN_PROMPT_SCAN_CHARS),
              stderr.recentTail(SIGN_IN_PROMPT_SCAN_CHARS),
            )
              ? idleMs
              : quietMs,
          );
        }
      }
    } catch (error) {
      // Providers may include command environment values in errors. Never expose the raw
      // error or its cause to runtime tool handling or a background completion observer.
      throw new Error(
        redactSecrets(error instanceof Error ? error.message : String(error), options.secrets),
      );
    } finally {
      clearIdle();
      clearOnOutputTimer();
      finished = true;
      resolveIdle?.("done");
    }
    return { ...redact(false), code: code ?? 0 };
  })();

  const reason = await Promise.race([
    idlePromise,
    done.then(
      () => "done" as const,
      () => "done" as const,
    ),
  ]);
  if (reason === "done" || finished || code !== undefined) {
    return { result: await done };
  }
  return {
    // The process is still running, so an unfinished secret prefix stays out of the
    // tool result. The completion publishes the rest once the command exits.
    result: { ...redact(true), code: null, running: true },
    completion: done,
  };
}
