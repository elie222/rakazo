import { readFileSync } from "node:fs";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkerHealth, watchEventLoopStalls, workerHealthIsFresh } from "./health.js";

const files = vi.hoisted(() => ({
  writeFile: vi.fn(async (_path: string, _data: string, _options: unknown) => {}),
  unlink: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", () => files);
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("worker health", () => {
  it("publishes reconciliation freshness and removes its heartbeat on shutdown", async () => {
    vi.useFakeTimers();
    const stop = startWorkerHealth(() => 123);
    await vi.advanceTimersByTimeAsync(30_000);
    const heartbeat = JSON.parse(files.writeFile.mock.calls.at(-1)![1] as string);
    expect(heartbeat.reconciled).toBe(123);
    await stop();
    expect(files.unlink).toHaveBeenCalled();
    const calls = files.writeFile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(files.writeFile).toHaveBeenCalledTimes(calls);
  });

  it("Docker probes reject stale heartbeats and stalled reconciliation", () => {
    expect(workerHealthIsFresh({ heartbeat: 1_000_000, reconciled: 1_000_000 }, 1_000_000)).toBe(
      true,
    );
    for (const health of [
      {},
      { heartbeat: 0, reconciled: 1_000_000 },
      { heartbeat: 1_000_000, reconciled: 0 },
      { heartbeat: "invalid", reconciled: NaN },
      { heartbeat: 1_000_000 - 90_001, reconciled: 1_000_000 },
      { heartbeat: 1_000_000, reconciled: 1_000_000 - 300_001 },
      { heartbeat: 1_000_000 + 5_001, reconciled: 1_000_000 },
    ]) {
      expect(workerHealthIsFresh(health, 1_000_000)).toBe(false);
    }
    for (const name of ["images", "prod", "topology", ""]) {
      const suffix = name ? `.${name}` : "";
      const source = readFileSync(`infra/compose/docker-compose${suffix}.yml`, "utf8");
      expect(source.slice(source.indexOf("\n  worker:"))).toContain(
        'test: ["CMD", "node", "dist/health-check.js"]',
      );
    }
  });

  it("reports a blocked event loop with heap figures, and not ordinary timer jitter", async () => {
    vi.useFakeTimers();
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink], level: "debug" }));
    let clock = 0;
    const stop = watchEventLoopStalls(() => clock);
    const tick = async (elapsed: number) => {
      clock += elapsed;
      await vi.advanceTimersByTimeAsync(1_000);
    };
    await tick(1_000);
    await tick(4_000);
    await tick(41_000);
    stop();
    await tick(60_000);

    const stalls = sink.events.filter((event) => event.message === "worker.event_loop_stalled");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ "event_loop.stall_ms": 40_000 });
    expect(stalls[0]!["memory.heap_limit_bytes"]).toBeGreaterThan(0);
  });
});
