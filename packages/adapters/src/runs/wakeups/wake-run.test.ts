import { runContinueJob } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wakeRun } from "./wake-run.js";

afterEach(() => {
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

function logged() {
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  return sink;
}

describe("wakeRun", () => {
  it("enqueues the run's continue job", async () => {
    const sink = logged();
    const enqueue = vi.fn(async () => undefined);

    await wakeRun({ enqueue }, "run-1");

    expect(enqueue.mock.calls).toStrictEqual([[runContinueJob("run-1")]]);
    expect(sink.events).toEqual([]);
  });

  it("passes a wake time and keepExisting through to the job", async () => {
    const enqueue = vi.fn(async () => undefined);
    const at = new Date("2026-01-02T03:04:05.000Z");

    await wakeRun({ enqueue }, "run-1", { at });
    await wakeRun({ enqueue }, "run-2", { keepExisting: true });

    expect(enqueue.mock.calls).toStrictEqual([
      [{ ...runContinueJob("run-1"), availableAt: at }],
      [{ ...runContinueJob("run-2"), keepExisting: true }],
    ]);
  });

  it.each([
    [
      "rejects",
      async () => {
        throw new Error("queue unavailable");
      },
    ],
    [
      "throws",
      () => {
        throw new Error("queue unavailable");
      },
    ],
  ])("resolves and logs once with the run id when the publisher %s", async (_name, enqueue) => {
    const sink = logged();

    await expect(wakeRun({ enqueue }, "run-1")).resolves.toBeUndefined();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      level: "error",
      message: "run wake failed",
      "run.id": "run-1",
      error: { message: "queue unavailable" },
    });
  });
});
