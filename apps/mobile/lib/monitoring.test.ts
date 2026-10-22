import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  close: vi.fn(async () => {}),
  setUser: vi.fn(),
  setTag: vi.fn(),
}));
vi.mock("@sentry/react-native", () => sdk);
const response = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("mobile monitoring", () => {
  it("stays optional, reports caught startup errors, and strips private data", async () => {
    const monitor = await import("./monitoring");
    const error = new Error("startup");
    monitor.reportMobileError(error, "react.render");
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8", userId: "a".repeat(64) }),
    );
    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      tags: { operation: "react.render", surface: "mobile" },
    });
    const options = sdk.init.mock.calls[0]![0];
    expect(options).toMatchObject({
      sendDefaultPii: false,
      enableLogs: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
    });
    expect(
      options.beforeSend({ extra: { secret: "private" }, user: { email: "private" } }),
    ).toEqual({ user: { id: "a".repeat(64), ip_address: null } });
    monitor.resetMobileMonitoring();
    expect(options.beforeSend({})).toBeNull();
    expect(sdk.setUser).toHaveBeenLastCalledWith(null);
    await monitor.configureMobileMonitoring(
      "https://other.example.com",
      {},
      response({ dsn: null }),
    );
    monitor.reportMobileError(new Error("off"), "react.render");
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
  });

  it("ignores stale config replies after a server change", async () => {
    const monitor = await import("./monitoring");
    let release!: (response: Response) => void;
    const pending = monitor.configureMobileMonitoring(
      "https://old.example.com",
      {},
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ) as unknown as typeof fetch,
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    monitor.resetMobileMonitoring();
    release(new Response(JSON.stringify({ dsn: "https://key@errors.example.com/8" })));
    await pending;
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("does not reinitialize unchanged native handlers when foregrounding", async () => {
    const monitor = await import("./monitoring");
    const fetchImpl = response({ dsn: "https://key@errors.example.com/8" });
    await monitor.configureMobileMonitoring("https://app.example.com", {}, fetchImpl);
    await monitor.configureMobileMonitoring("https://app.example.com", {}, fetchImpl);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    monitor.reportMobileError(new Error("after foreground"), "voice.turn");
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
  });

  it("shares pending configuration and retries after it fails", async () => {
    const monitor = await import("./monitoring");
    let release!: (value: Response) => void;
    const fetchConfig = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const first = monitor.configureMobileMonitoring("https://app.example.com", {}, fetchConfig);
    await vi.waitFor(() => expect(fetchConfig).toHaveBeenCalledTimes(1));
    expect(monitor.configureMobileMonitoring("https://app.example.com", {}, fetchConfig)).toBe(
      first,
    );
    release(new Response(null, { status: 503 }));
    await first;

    const error = new Error("waiting for reporting");
    monitor.reportMobileError(error, "voice.turn");
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      tags: { operation: "voice.turn", surface: "mobile" },
    });
  });

  it("reopens a previous connection after a failed switch without replaying the other connection's errors", async () => {
    const monitor = await import("./monitoring");
    const fetchConfig = response({ dsn: "https://key@errors.example.com/8" });
    await monitor.configureMobileMonitoring("https://first.example.com", {}, fetchConfig);
    const previous = sdk.init.mock.calls[0]![0];
    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    await monitor.configureMobileMonitoring("https://second.example.com", {}, offline);
    monitor.reportMobileError(new Error("second connection"), "voice.turn");
    await monitor.configureMobileMonitoring("https://first.example.com", {}, fetchConfig);
    expect(sdk.init).toHaveBeenCalledTimes(2);
    expect(previous.beforeSend({})).toBeNull();
    expect(sdk.captureException).not.toHaveBeenCalled();
    const error = new Error("first connection restored");
    monitor.reportMobileError(error, "voice.turn");
    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      tags: { operation: "voice.turn", surface: "mobile" },
    });
    await monitor.configureMobileMonitoring("https://first.example.com", {}, fetchConfig);
    expect(sdk.init).toHaveBeenCalledTimes(2);
  });
});
