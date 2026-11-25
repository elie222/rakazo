import { Readable } from "node:stream";
import { createLogger, createTestSink, installLogger, runWithLogContext } from "@rakazo/logging";
import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { warnNearLimits } from "./computer-limits.js";
import { runContainerCommand } from "./exec.js";

function computer(id: string, reading: object = {}) {
  return {
    id,
    exec: vi.fn(async () => ({
      start: async () => Readable.from([]),
      inspect: async () => ({ ExitCode: 1 }),
    })),
    stats: vi.fn(async () => reading),
  } as unknown as Docker.Container;
}

const nearItsPidLimit = {
  pids_stats: { current: 1980, limit: 2048 },
  memory_stats: { usage: 300_000_000, limit: 2 ** 31, stats: {} },
};

describe("computer limits", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
  });

  it("warns when a computer whose command failed is near its PID limit, once a minute", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-sandbox-supervisor", sinks: [sink] }));
    const container = computer("threaded", nearItsPidLimit);

    await runContainerCommand(container, ["false"]);
    await vi.waitFor(() =>
      expect(sink.events).toEqual([
        expect.objectContaining({
          level: "warn",
          message: "computer.pids_near_limit",
          "container.id": "threaded",
          "pids.current": 1980,
          "pids.limit": 2048,
        }),
      ]),
    );

    await runContainerCommand(container, ["false"]);
    expect(container.stats).toHaveBeenCalledOnce();
  });

  it("does not repeat the failed request's error on its warning", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-sandbox-supervisor", sinks: [sink] }));

    runWithLogContext({ error: new Error("computer screen failed to stop") }, () =>
      warnNearLimits(computer("at-its-limit", nearItsPidLimit)),
    );
    await vi.waitFor(() => expect(sink.events).toHaveLength(1));

    expect(sink.events[0]).toMatchObject({ message: "computer.pids_near_limit" });
    expect(sink.events[0]).not.toHaveProperty("error");
  });

  it("counts idle file cache as free before warning that memory is near its limit", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-sandbox-supervisor", sinks: [sink] }));
    const limit = 2 ** 31;
    const reading = (stats: Record<string, number>) => ({
      pids_stats: { current: 20, limit: 2048 },
      memory_stats: { usage: 2_100_000_000, limit, stats },
    });

    warnNearLimits(computer("cgroup-v2", reading({ inactive_file: 1_000_000_000 })));
    warnNearLimits(
      computer("cgroup-v1", reading({ inactive_file: 0, total_inactive_file: 1_000_000_000 })),
    );
    warnNearLimits(computer("full", reading({})));
    await vi.waitFor(() => expect(sink.events).toHaveLength(1));

    expect(sink.events[0]).toMatchObject({
      level: "warn",
      message: "computer.memory_near_limit",
      "container.id": "full",
      "memory.current": 2_100_000_000,
      "memory.limit": limit,
    });
  });
});
