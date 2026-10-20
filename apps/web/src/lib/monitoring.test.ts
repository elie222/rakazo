import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ init: vi.fn(), captureReactException: vi.fn() }));
vi.mock("@sentry/react", () => sentry);

import { reportCaughtReactError, startMonitoring } from "./monitoring";

function respond(body: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("browser monitoring", () => {
  it("reports errors caught before startup finishes once the SDK starts", async () => {
    vi.resetModules();
    const fresh = await import("./monitoring");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const early = new Error("first render");
    fresh.reportCaughtReactError(early, { componentStack: "\n    at App" });
    expect(sentry.captureReactException).not.toHaveBeenCalled();

    expect(await fresh.startMonitoring(respond({ dsn: "https://key@errors.example.com/8" }))).toBe(
      true,
    );
    expect(sentry.captureReactException).toHaveBeenCalledWith(early, {
      componentStack: "\n    at App",
    });
    consoleError.mockRestore();
  });

  it("drops queued errors when monitoring is off", async () => {
    vi.resetModules();
    const fresh = await import("./monitoring");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fresh.reportCaughtReactError(new Error("early"), { componentStack: "" });
    expect(await fresh.startMonitoring(respond({ dsn: null }))).toBe(false);
    expect(await fresh.startMonitoring(respond({ dsn: "https://key@errors.example.com/8" }))).toBe(
      true,
    );
    expect(sentry.captureReactException).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  beforeEach(() => {
    sentry.init.mockReset();
    sentry.captureReactException.mockReset();
  });

  it("stays off when the API has no browser DSN or cannot be reached", async () => {
    expect(await startMonitoring(respond({ dsn: null }))).toBe(false);
    expect(await startMonitoring(respond({}, 404))).toBe(false);
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await startMonitoring(offline)).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("stays off when the SDK fails to start", async () => {
    sentry.init.mockImplementation(() => {
      throw new Error("init failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await startMonitoring(respond({ dsn: "https://key@errors.example.com/8" }))).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("starts the SDK through the API tunnel with data collection off", async () => {
    const fetchImpl = respond({
      dsn: "https://key@errors.example.com/8",
      environment: "prod-acme",
      release: "abc",
      tunnel: "/api/monitoring/tunnel",
    });
    expect(await startMonitoring(fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("/api/monitoring/config");
    const options = sentry.init.mock.calls[0]![0];
    expect(options).toMatchObject({
      dsn: "https://key@errors.example.com/8",
      environment: "prod-acme",
      release: "abc",
      tunnel: "/api/monitoring/tunnel",
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false },
    });
    expect(options.integrations([{ name: "BrowserSession" }, { name: "GlobalHandlers" }])).toEqual([
      { name: "GlobalHandlers" },
    ]);
    expect(options.beforeBreadcrumb({ category: "console", message: "x" })).toBeNull();
    expect(options.beforeBreadcrumb({ category: "fetch" })).toEqual({ category: "fetch" });

    for (const category of ["ui.click", "ui.input"]) {
      expect(options.beforeBreadcrumb({ category, message: "private text" })).toBeNull();
    }
    for (const category of ["fetch", "xhr", "navigation"]) {
      expect(
        options.beforeBreadcrumb({
          category,
          data: {
            url: "https://example.com/path?token=secret#private",
            from: "/before?query=secret",
            to: "/after#private",
            status_code: 500,
          },
        }),
      ).toEqual({
        category,
        data: { url: "https://example.com/path", from: "/before", to: "/after", status_code: 500 },
      });
    }
    expect(
      options.beforeSend({
        request: {
          url: "https://example.com/path?token=secret#private",
          headers: { authorization: "secret" },
          cookies: "secret",
          data: "private body",
        },
        user: { email: "private@example.com" },
      }),
    ).toEqual({ request: { url: "https://example.com/path" } });
    expect(options.beforeSend({})).toEqual({});
    expect(
      options.beforeSend({
        message: "Failed for someone@example.com",
        exception: { values: [{ value: "401 Bearer abc.def from someone@example.com" }] },
      }),
    ).toEqual({
      message: "Failed for [Redacted]",
      exception: { values: [{ value: "401 Bearer [Redacted] from [Redacted]" }] },
    });
    expect(
      options.beforeSend({
        exception: {
          values: [
            { stacktrace: { frames: [{ filename: "https://app.example.com/a.js?token=x#y" }] } },
          ],
        },
      }),
    ).toEqual({
      exception: {
        values: [{ stacktrace: { frames: [{ filename: "https://app.example.com/a.js" }] } }],
      },
    });
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.profilesSampleRate).toBeUndefined();
    expect(options.replaysSessionSampleRate).toBeUndefined();
    expect(options.replaysOnErrorSampleRate).toBeUndefined();

    const error = new Error("boom");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    reportCaughtReactError(error, { componentStack: "\n    at Thread" });
    expect(sentry.captureReactException).toHaveBeenCalledWith(error, {
      componentStack: "\n    at Thread",
    });
    expect(consoleError).toHaveBeenCalledWith(error);
    consoleError.mockRestore();
  });
});
