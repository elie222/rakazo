import { PassThrough, Readable } from "node:stream";
import { createLogger, createTestSink, installLogger, runWithLogContext } from "@rakazo/logging";
import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { warnNearLimits } from "./computer-limits.js";
import { readContainerFile, runContainerCommand } from "./exec.js";

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

  it("ignores caller cancellation and file-read size exits so a following failure still warns", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-sandbox-supervisor", sinks: [sink] }));
    let step = 0;
    const container = {
      id: "cancel-then-fail",
      exec: vi.fn(async () => {
        step += 1;
        if (step === 1) {
          const stream = new PassThrough();
          return {
            start: async () => stream,
            inspect: async () => ({ ExitCode: 137 }),
          };
        }
        if (step === 2 || step === 3) {
          return {
            start: async () => Readable.from([]),
            inspect: async () => ({ ExitCode: 42 }),
          };
        }
        return {
          start: async () => Readable.from([]),
          inspect: async () => ({ ExitCode: 1 }),
        };
      }),
      stats: vi.fn(async () => nearItsPidLimit),
    } as unknown as Docker.Container;

    const controller = new AbortController();
    const cancelledRun = runContainerCommand(container, ["sleep", "60"], {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(container.exec).toHaveBeenCalledTimes(1));
    controller.abort(new Error("client disconnected"));
    await expect(cancelledRun).rejects.toThrow("client disconnected");

    expect(
      await readContainerFile(container, "/home/rakazo/big.bin", {
        maxBytes: 10,
        signalMidStreamOverflow: true,
      }),
    ).toEqual({ kind: "too_large" });
    expect(
      await readContainerFile(container, "/home/rakazo/big.bin", {
        maxBytes: 10,
      }),
    ).toEqual({ kind: "too_large" });
    expect(container.stats).not.toHaveBeenCalled();

    await runContainerCommand(container, ["false"]);
    await vi.waitFor(() =>
      expect(sink.events).toEqual([
        expect.objectContaining({
          level: "warn",
          message: "computer.pids_near_limit",
          "container.id": "cancel-then-fail",
        }),
      ]),
    );
    expect(container.stats).toHaveBeenCalledOnce();
  });
});
