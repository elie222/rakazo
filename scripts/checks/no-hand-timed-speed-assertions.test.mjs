import assert from "node:assert/strict";
import { test } from "node:test";
import { pattern } from "./ratchets/no-hand-timed-speed-assertions.mjs";

const hits = (text) => text.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0;

test("counts a test that reads the clock against a fixed bound", () => {
  assert.equal(hits("expect(performance.now() - started).toBeLessThan(500);"), 1);
  assert.equal(hits("expect(Date.now() - this.startedAt).toBeLessThanOrEqual(2_000);"), 1);
  assert.equal(hits('expect(performance.now() - started, "too slow").toBeLessThan(500);'), 1);
});

test("counts an elapsed time kept in a variable and bounded later", () => {
  const kept = `const elapsed = performance.now() - started;
    expect(result).toBe(1);
    expect(elapsed).toBeLessThan(500);`;
  assert.equal(hits(kept), 1);
  assert.equal(hits("tookMs = Date.now() - start;\nexpect(tookMs, `slow`).toBeLessThan(9);"), 1);
});

test("ignores the shared helper, elapsed values kept for other checks, and lower bounds", () => {
  assert.equal(hits("expectLinearTime(() => parse(input));"), 0);
  assert.equal(hits("looks.push(Date.now() - started);"), 0);
  assert.equal(hits("expect(Date.now() - started).toBeGreaterThan(1_000);"), 0);
  assert.equal(hits("const waited = Date.now() - started;\nexpect(waited).toBeGreaterThan(9);"), 0);
  assert.equal(hits("const a = Date.now() - s;\nexpect(ab).toBeLessThan(9);"), 0);
});
