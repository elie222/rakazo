import { describe, expect, it, vi } from "vitest";
import {
  clientCorrelationHeaders,
  createClientErrorReporter,
  responseCorrelation,
  sanitizedError,
  sanitizeMonitoringEvent,
} from "./monitoring.js";

describe("client monitoring contract", () => {
  it("bounds startup reports, drains once, and clears disabled or previous-server reports", () => {
    const reporter = createClientErrorReporter();
    const capture = vi.fn();
    for (let i = 0; i < 30; i++) reporter.capture(new Error("startup"), "react.render");
    reporter.install({ capture });
    expect(capture).toHaveBeenCalledTimes(20);
    reporter.install({ capture });
    expect(capture).toHaveBeenCalledTimes(20);
    reporter.reset();
    reporter.capture(new Error("old server"), "react.render");
    reporter.reset();
    reporter.install({ capture });
    expect(capture).toHaveBeenCalledTimes(20);
    reporter.install(undefined);
    reporter.capture(new Error("disabled"), "react.render");
    reporter.install({ capture });
    expect(capture).toHaveBeenCalledTimes(20);
  });

  it("scrubs credentials, identity and paths while preserving stack and cause", () => {
    const source = new Error("Bearer abc.def", { cause: new Error("password=secret") });
    source.stack = "Error: Bearer abc.def\n at work (/Users/example/app.js:12:3)";
    const safe = sanitizedError(source);
    expect(safe.stack).toContain("/[user]/app.js:12:3");
    expect(safe.stack).not.toContain("abc.def");
    expect((safe.cause as Error).message).not.toContain("secret");
    expect(source.message).toBe("Bearer abc.def");
    source.cause = source;
    expect(() => sanitizedError(source)).not.toThrow();
  });

  it("only sends the server-minted user and sanitized diagnostic fields", () => {
    const result = sanitizeMonitoringEvent(
      {
        request: {
          url: "https://app.example.com/a?token=x",
          headers: { authorization: "secret" },
          data: "private",
        },
        user: { id: "raw-account", email: "private@example.com" },
        extra: { prompt: "private" },
        breadcrumbs: [{ message: "private" }],
        server_name: "private-machine",
        exception: {
          values: [
            {
              value: "Bearer abc.def",
              stacktrace: {
                frames: [{ filename: "/home/example/a.js?token=x", vars: { secret: "x" } }],
              },
            },
          ],
        },
      },
      "a".repeat(64),
    );
    expect(result.user).toEqual({ id: "a".repeat(64), ip_address: null });
    expect(JSON.stringify(result)).not.toMatch(/private|raw-account|abc.def|example\/a|token=x/);
    expect(sanitizeMonitoringEvent({ user: undefined }, "raw-user").user).toEqual({
      ip_address: null,
    });
  });

  it("uses valid W3C headers shared by client errors and the API", () => {
    const headers = clientCorrelationHeaders(() => "12345678-1234-4234-9234-123456789abc");
    expect(headers.traceparent).toBe("00-12345678123442349234123456789abc-1234567812344234-01");
    const tags = responseCorrelation(new Headers(headers));
    expect(tags).toEqual({
      "trace.id": "12345678123442349234123456789abc",
      "request.id": "12345678-1234-4234-9234-123456789abc",
    });
    expect(
      responseCorrelation(new Headers({ traceparent: "secret", "x-request-id": "Bearer secret" })),
    ).toEqual({});
  });
});
