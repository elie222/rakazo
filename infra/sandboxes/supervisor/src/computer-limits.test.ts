import { Readable } from "node:stream";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
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

describe("computer limits", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo", level: "off", sinks: [] }));
  });

  it("warns when a computer whose command failed is near its PID limit, once a minute", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-sandbox-supervisor", sinks: [sink] }));
    const container = computer("threaded", {
      pids_stats: { current: 1980, limit: 2048 },
      memory_stats: { usage: 300_000_000, limit: 2 ** 31, stats: {} },
    });

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

  it("counts idle file cache as free before warning that memory is near its limit", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-sandbox-supervisor", sinks: [sink] }));
    const usage = 2_100_000_000;
    const reading = (inactiveFile: number) => ({
      pids_stats: { current: 20, limit: 2048 },
      memory_stats: { usage, limit: 2 ** 31, stats: { inactive_file: inactiveFile } },
    });

    warnNearLimits(computer("cached", reading(1_000_000_000)));
    warnNearLimits(computer("full", reading(0)));
    await vi.waitFor(() => expect(sink.events).toHaveLength(1));

    expect(sink.events[0]).toMatchObject({
      level: "warn",
      message: "computer.memory_near_limit",
      "container.id": "full",
      "memory.current": usage,
      "memory.limit": 2 ** 31,
    });
  });
});
