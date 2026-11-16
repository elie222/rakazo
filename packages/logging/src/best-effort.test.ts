import { afterEach, describe, expect, it } from "vitest";
import { bestEffort } from "./best-effort.js";
import { createLogger, getLogger, installLogger } from "./logger.js";
import { createTestSink } from "./test-sink.js";

describe("bestEffort", () => {
  const previous = getLogger();
  afterEach(() => installLogger(previous));

  function captureLogs() {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    return sink.events;
  }

  it("resolves to the value and logs nothing when the work succeeds", async () => {
    const events = captureLogs();
    await expect(bestEffort("read the cache", Promise.resolve("hit"))).resolves.toBe("hit");
    expect(events).toEqual([]);
  });

  it("resolves to undefined and logs the label and error once when the work fails", async () => {
    const events = captureLogs();
    const failure = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    await expect(
      bestEffort("close the database pool", Promise.reject(failure)),
    ).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "warn",
      message: "best effort failed: close the database pool",
      error: { name: "Error", message: "socket hang up", code: "ECONNRESET" },
    });
  });

  it("logs a failure that is not an Error", async () => {
    const events = captureLogs();
    await expect(
      bestEffort("stop the container", Promise.reject("no such container")),
    ).resolves.toBeUndefined();
    expect(events[0]?.error).toMatchObject({ message: "no such container" });
  });

  it("accepts the missing promise of an optional call", async () => {
    const events = captureLogs();
    const response: { body?: { cancel(): Promise<void> } } = {};
    await expect(
      bestEffort("cancel the response body", response.body?.cancel()),
    ).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it("resolves to undefined without logging when the work was cancelled", async () => {
    const events = captureLogs();
    const controller = new AbortController();
    controller.abort();
    const cancelled = new Promise<void>((_, reject) => {
      reject(controller.signal.reason);
    });
    await expect(bestEffort("delete the upload", cancelled)).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it("logs a cleanup that ran out of time", async () => {
    const events = captureLogs();
    const timedOut = Promise.reject(new DOMException("timed out", "TimeoutError"));
    await expect(bestEffort("close the connection", timedOut)).resolves.toBeUndefined();
    expect(events[0]).toMatchObject({ error: { name: "TimeoutError" } });
  });
});
