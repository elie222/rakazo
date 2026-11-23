import { abortableDelay } from "./async.js";
import { isRetryableError, retryDelayMs } from "./retry-policy.js";

const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 30_000;

export interface RetryOptions {
  /** Tries in total, the first included. */
  attempts: number;
  /**
   * The exact wait after a failed try: one value, a list by try (its last entry repeats), or a
   * function of the failed try's index (0 for the first) and its error. Left out, the shared
   * policy applies: the wait the error asked for (`retryAfterMs`), otherwise a jittered backoff
   * doubling from 250 ms up to 30 s.
   */
  delayMs?: number | readonly number[] | ((attempt: number, error: unknown) => number);
  /** Which failures deserve another try. Defaults to {@link isRetryableError}. */
  retryable?: (error: unknown) => boolean | Promise<boolean>;
  /** Called before each wait with the failure being retried, for logging. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Ends a wait early; `retry` then rejects with the signal's reason. */
  signal?: AbortSignal;
  random?: () => number;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Runs `operation` until it succeeds, a failure is not retryable, or the tries run out, and
 * rejects with the last failure. The operation honors the signal while it runs; `retry` honors it
 * between tries.
 */
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts, signal, retryable = isRetryableError, delay = abortableDelay } = options;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt + 1 >= attempts || !(await retryable(error))) throw error;
      const ms = retryWaitMs(options, attempt, error);
      options.onRetry?.(error, attempt, ms);
      if (ms > 0) await delay(ms, signal);
      signal?.throwIfAborted();
    }
  }
}

function retryWaitMs(options: RetryOptions, attempt: number, error: unknown): number {
  const { delayMs } = options;
  if (delayMs === undefined) {
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
    return retryDelayMs(error, backoff, options.random);
  }
  if (typeof delayMs === "number") return delayMs;
  if (typeof delayMs === "function") return delayMs(attempt, error);
  return delayMs[Math.min(attempt, delayMs.length - 1)] ?? 0;
}

export interface PollOptions {
  /** Wait between looks: fixed, or from how many looks have found nothing (1 after the first). */
  intervalMs: number | ((looks: number) => number);
  /** Read after each look that found nothing, so the last look can start one wait past it. */
  timeoutMs: number;
  /** Ends a wait early; `pollUntil` then rejects with the signal's reason. */
  signal?: AbortSignal;
}

type Found<T> = Exclude<T, false | null | undefined>;

/**
 * Calls `check` until it returns something other than false, null or undefined, and resolves
 * with that. Past the deadline it rejects naming `waitingFor`, or settles as `onTimeout` does.
 * A `check` that throws ends the poll with its error.
 */
export function pollUntil<T>(
  check: () => T | Promise<T>,
  options: PollOptions & { waitingFor: string },
): Promise<Found<T>>;
export function pollUntil<T, R>(
  check: () => T | Promise<T>,
  options: PollOptions & { onTimeout: () => R },
): Promise<Found<T> | R>;
export async function pollUntil<T, R>(
  check: () => T | Promise<T>,
  options: PollOptions & { waitingFor?: string; onTimeout?: () => R },
): Promise<Found<T> | R> {
  const { intervalMs, timeoutMs, signal, onTimeout } = options;
  const deadline = Date.now() + timeoutMs;
  for (let looks = 1; ; looks += 1) {
    const value = await check();
    if (value !== false && value !== null && value !== undefined) return value as Found<T>;
    if (Date.now() >= deadline) {
      if (onTimeout) return onTimeout();
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${options.waitingFor}`);
    }
    await abortableDelay(typeof intervalMs === "number" ? intervalMs : intervalMs(looks), signal);
    signal?.throwIfAborted();
  }
}
