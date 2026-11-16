import { expect } from "vitest";

/**
 * Runs `work` and fails if it takes more than a few seconds. Callers size their input so a
 * backtracking pattern would take far longer, so a slow or busy runner never trips the limit.
 */
export function expectLinearTime(work: () => unknown) {
  const started = performance.now();
  work();
  expect(performance.now() - started).toBeLessThan(3_000);
}
