import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SinkGuard from "./sink-guard.js";

let sinkGuard: typeof SinkGuard;
const now = Date.UTC(2026, 0, 1);

beforeEach(async () => {
  vi.resetModules();
  sinkGuard = await import("./sink-guard.js");
  vi.spyOn(Date, "now").mockReturnValue(now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sink failure diagnostics", () => {
  const sensitive = "sink unavailable: Bearer fake-bearer for person@example.com api_key=fake-key";
  const redacted = "sink unavailable: Bearer [Redacted] for [Redacted] api_key=[Redacted]";

  it.each([
    {
      name: "error stack",
      error: Object.assign(new Error("sink unavailable"), {
        stack: `Error: ${sensitive}\n    at sink`,
      }),
      expected: `Error: ${redacted}\n    at sink`,
    },
    {
      name: "error without a stack",
      error: Object.assign(new Error(sensitive), { stack: undefined }),
      expected: redacted,
    },
    { name: "string rejection", error: sensitive, expected: redacted },
    {
      name: "stringified rejection",
      error: { toString: (): string => sensitive },
      expected: redacted,
    },
    {
      name: "rejection that cannot be printed",
      error: {
        toString: (): string => {
          throw new Error("no text");
        },
      },
      expected: "unprintable error",
    },
  ])("redacts the $name before writing to the console", ({ error, expected }) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    sinkGuard.reportSinkError(error);

    expect(consoleError).toHaveBeenCalledExactlyOnceWith("log sink failed", expected);
  });

  it.each([
    {
      name: "synchronous write",
      fail: (error: Error) =>
        sinkGuard.guardedWrite(() => {
          throw error;
        }),
    },
    {
      name: "asynchronous write",
      fail: (error: Error) => sinkGuard.guardedWrite(() => Promise.reject(error)),
    },
    {
      name: "synchronous flush",
      fail: (error: Error) =>
        sinkGuard.guardedFlush(() => {
          throw error;
        }),
    },
    {
      name: "asynchronous flush",
      fail: (error: Error) => sinkGuard.guardedFlush(() => Promise.reject(error)),
    },
  ])("redacts $name failures without propagating them", async ({ fail }) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error(sensitive), { stack: `Error: ${sensitive}` });

    await fail(error);

    expect(consoleError).toHaveBeenCalledExactlyOnceWith("log sink failed", `Error: ${redacted}`);
  });

  it("preserves throttling and sink health while redacting the next report", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    sinkGuard.reportSinkError("first failure");
    sinkGuard.reportSinkError(sensitive);
    expect(consoleError).toHaveBeenCalledExactlyOnceWith("log sink failed", "first failure");
    expect(sinkGuard.logSinkHealth()).toMatchObject({
      failures: 2,
      lastFailureAt: now,
      degraded: true,
    });

    const nextReportAt = now + 30_000;
    vi.mocked(Date.now).mockReturnValue(nextReportAt);
    sinkGuard.reportSinkError(sensitive);

    expect(consoleError).toHaveBeenLastCalledWith("log sink failed (1 suppressed)", redacted);
    expect(sinkGuard.logSinkHealth()).toMatchObject({
      failures: 3,
      lastFailureAt: nextReportAt,
      degraded: true,
    });
    expect(sinkGuard.logSinkHealth(nextReportAt + 300_000).degraded).toBe(false);
  });
});
