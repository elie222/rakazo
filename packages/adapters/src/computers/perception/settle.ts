import type {
  ComputerObservation,
  ComputerSettleRequest,
  ComputerSettleResult,
} from "@rakazo/adapter-kit";
import { abortableDelay } from "@rakazo/core";

export interface SettleOptions {
  observe(): Promise<ComputerObservation>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Wait for the screen to stop changing. This is the provider-neutral fallback: it compares frame
 * identities instead of reading XDamage, so every Linux provider can settle without a new helper.
 */
export async function settleScreen(
  request: ComputerSettleRequest,
  signal: AbortSignal,
  options: SettleOptions,
): Promise<ComputerSettleResult> {
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? ((ms, abort) => abortableDelay(ms, abort));
  const timeoutMs = bounded(request.timeoutMs, 1, 30_000, 3_000);
  const firstMs = bounded(request.firstMs, 0, 10_000, 1_500);
  const quietMs = bounded(request.quietMs, 1, 5_000, 250);
  const started = now();
  let previous = await options.observe();
  let lastChange: number | null = null;
  // When the frame was first seen unchanged. A short timeout must not report a screen quiet
  // before a whole quiet window went by.
  let quietSince: number | null = null;
  while (now() - started < timeoutMs) {
    signal.throwIfAborted();
    const left = timeoutMs - (now() - started);
    await wait(Math.min(quietMs, Math.max(1, left)), signal);
    const next = await options.observe();
    if (next.frameId !== previous.frameId) {
      lastChange = now();
      previous = next;
      quietSince = null;
      continue;
    }
    if (quietSince === null) quietSince = now();
    if (quietSince - started >= firstMs && now() - quietSince >= quietMs) {
      return {
        changed: [],
        lastChangeMono: lastChange,
        quiet: true,
        noVisibleChange: lastChange === null,
      };
    }
  }
  return { changed: [], lastChangeMono: lastChange, quiet: false, noVisibleChange: false };
}

function bounded(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}
