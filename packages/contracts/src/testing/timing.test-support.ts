import { expect } from "vitest";

const LIMIT_MS = 3_000;

/**
 * Runs `work` and fails if it takes more than a few seconds. Callers size their input so a
 * backtracking pattern would take far longer, so a slow or busy runner never trips the limit.
 */
export function expectLinearTime(work: () => Promise<unknown>): Promise<void>;
export function expectLinearTime(work: () => unknown): void;
export function expectLinearTime(work: () => unknown): Promise<void> | void {
  const started = performance.now();
  const result = work();
  if (result instanceof Promise)
    return result.then(() => {
      expect(performance.now() - started).toBeLessThan(LIMIT_MS);
    });
  expect(performance.now() - started).toBeLessThan(LIMIT_MS);
}
