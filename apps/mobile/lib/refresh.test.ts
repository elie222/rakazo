import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUBSCRIBE_IDLE_TIMEOUT_MS, subscribeRetryDelayMs } from "./refresh";

describe("thread subscribe reconnect", () => {
  it("backs off after a dropped stream and caps at five seconds", () => {
    expect(subscribeRetryDelayMs(0)).toBe(250);
    expect(subscribeRetryDelayMs(1)).toBe(500);
    expect(subscribeRetryDelayMs(2)).toBe(1_000);
    expect(subscribeRetryDelayMs(20)).toBe(5_000);
  });

  it("defines a finite idle timeout so silent SSE streams recover", () => {
    expect(SUBSCRIBE_IDLE_TIMEOUT_MS).toBe(45_000);
  });

  it("keeps the open thread on SSE instead of polling snapshots", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const thread = readFileSync(path.join(dir, "../app/thread.tsx"), "utf8");
    expect(thread).toContain("subscribeThread");
    expect(thread).not.toContain("threadRefreshDelayMs");
    expect(thread).not.toMatch(/setTimeout\(\(\) => void tick\(\)/);
  });
});
