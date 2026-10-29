import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  flush: vi.fn(async () => true),
  captureException: vi.fn(),
  close: vi.fn(async () => {}),
  setUser: vi.fn(),
  setTag: vi.fn(),
}));
const updates = vi.hoisted(() => ({
  channel: "production",
  readLogEntriesAsync: vi.fn(
    async () => [] as Array<{ code: string; level: string; timestamp: number; message: string }>,
  ),
}));
vi.mock("expo-updates", () => updates);
const application = {
  applicationId: "com.example.app",
  nativeApplicationVersion: "1.0.8",
  nativeBuildVersion: "20",
};
const storage = vi.hoisted(() => new Map<string, string>());
const secureStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
};
vi.mock("@sentry/react-native", () => sdk);
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  get PushNotificationIOS() {
    throw new Error("optional native module is unavailable");
  },
}));
const response = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  storage.clear();
  sdk.flush.mockResolvedValue(true);
  updates.channel = "production";
  updates.readLogEntriesAsync.mockResolvedValue([]);
  application.nativeApplicationVersion = "1.0.8";
  application.nativeBuildVersion = "20";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function installErrorUtils() {
  const previous = vi.fn();
  let handler: (error: Error, fatal?: boolean) => void = previous;
  vi.stubGlobal("ErrorUtils", {
    getGlobalHandler: () => handler,
    setGlobalHandler: (next: typeof handler) => {
      handler = next;
    },
  });
  return { previous, handle: (error: Error, fatal?: boolean) => handler(error, fatal) };
}

describe("mobile monitoring", () => {
  it("flushes an early fatal error before handing it to native recovery", async () => {
    vi.useFakeTimers();
    const native = installErrorUtils();
    const monitor = await import("./monitoring");
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    const error = new Error("startup failed");
    native.handle(error, true);
    expect(native.previous).not.toHaveBeenCalled();
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    await vi.waitFor(() => expect(native.previous).toHaveBeenCalledExactlyOnceWith(error, true));
    expect(sdk.captureException).toHaveBeenCalledExactlyOnceWith(error, {
      mechanism: { handled: false, type: "onerror" },
      captureContext: { level: "fatal", tags: { operation: "mobile.startup", surface: "mobile" } },
    });
    expect(sdk.flush).toHaveBeenCalledOnce();
    expect((await import("./startup-error")).readStartupError(secureStorage)).toBeUndefined();
  });

  it("preserves a fatal error across process restarts when configuration never arrives", async () => {
    vi.useFakeTimers();
    const native = installErrorUtils();
    let monitor = await import("./monitoring");
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    const error = new TypeError("startup failed");
    native.handle(error, true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(native.previous).toHaveBeenCalledExactlyOnceWith(error, true);
    expect(sdk.captureException).not.toHaveBeenCalled();

    application.nativeApplicationVersion = "1.0.9";
    application.nativeBuildVersion = "21";
    vi.resetModules();
    installErrorUtils();
    monitor = await import("./monitoring");
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    expect(sdk.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "TypeError",
        message: error.message,
        stack: expect.stringContaining("monitoring.test.ts"),
      }),
      {
        mechanism: { handled: false, type: "onerror" },
        captureContext: {
          level: "fatal",
          tags: {
            operation: "mobile.startup",
            surface: "mobile",
            "startup.previous_launch": "true",
          },
          extra: { __sentry_release: "com.example.app@1.0.8+20", __sentry_dist: "20" },
        },
      },
    );
    await vi.waitFor(async () =>
      expect((await import("./startup-error")).readStartupError(secureStorage)).toBeUndefined(),
    );
    const beforeSend = sdk.init.mock.calls[0]![0].beforeSend;
    expect(beforeSend({ tags: { "startup.previous_launch": "true" } }).user).toEqual({
      ip_address: null,
    });
  });

  it("still sends the fatal error when the ordinary early-error queue is full", async () => {
    const native = installErrorUtils();
    const monitor = await import("./monitoring");
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    for (let i = 0; i < 25; i++) monitor.reportMobileError(new Error("nonfatal"), "react.render");
    const fatal = new Error("startup failed");
    native.handle(fatal, true);
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    expect(sdk.captureException).toHaveBeenCalledWith(fatal, {
      mechanism: { handled: false, type: "onerror" },
      captureContext: { level: "fatal", tags: { operation: "mobile.startup", surface: "mobile" } },
    });
    await vi.waitFor(() => expect(native.previous).toHaveBeenCalledExactlyOnceWith(fatal, true));
  });

  it("keeps the startup failure when anonymous reporting acquires the saved session", async () => {
    const native = installErrorUtils();
    const monitor = await import("./monitoring");
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    let release!: (value: Response) => void;
    const anonymous = monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const error = new Error("startup failed");
    native.handle(error, true);
    const authenticated = monitor.configureMobileMonitoring(
      "https://app.example.com",
      { authorization: "Bearer fake-session" },
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    release(new Response(JSON.stringify({ dsn: "https://key@errors.example.com/8" })));
    await Promise.all([anonymous, authenticated]);
    expect(sdk.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        captureContext: expect.objectContaining({ level: "fatal" }),
      }),
    );
    await vi.waitFor(() => expect(native.previous).toHaveBeenCalledExactlyOnceWith(error, true));
  });

  it("aborts a superseded anonymous configuration so fatal reporting need not wait for its timeout", async () => {
    const native = installErrorUtils();
    const monitor = await import("./monitoring");
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    let signal: AbortSignal | undefined;
    const anonymous = monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    const error = new Error("startup failed");
    native.handle(error, true);
    const authenticated = monitor.configureMobileMonitoring(
      "https://app.example.com",
      { authorization: "Bearer fake-session" },
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    expect(signal?.aborted).toBe(true);
    await Promise.all([anonymous, authenticated]);
    await vi.waitFor(() => expect(native.previous).toHaveBeenCalledExactlyOnceWith(error, true));
    expect(sdk.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        captureContext: expect.objectContaining({ level: "fatal" }),
      }),
    );
  });

  it("retains the first fatal failure when another arrives before configuration", async () => {
    vi.useFakeTimers();
    const native = installErrorUtils();
    const monitor = await import("./monitoring");
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    const first = new Error("original startup failure");
    native.handle(first, true);
    native.handle(new Error("follow-on failure"), true);
    expect((await import("./startup-error")).readStartupError(secureStorage)?.error.message).toBe(
      first.message,
    );
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    await vi.waitFor(() => expect(native.previous).toHaveBeenCalledExactlyOnceWith(first, true));
    expect(sdk.captureException).toHaveBeenCalledExactlyOnceWith(first, expect.any(Object));
  });

  it("skips a stale request superseded while the previous SDK is closing", async () => {
    const monitor = await import("./monitoring");
    const config = { dsn: "https://key@errors.example.com/8" };
    await monitor.configureMobileMonitoring("https://first.example.com", {}, response(config));
    let finishClose!: () => void;
    sdk.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const staleFetch = response(config);
    const stale = monitor.configureMobileMonitoring("https://stale.example.com", {}, staleFetch);
    await vi.waitFor(() => expect(finishClose).toBeTypeOf("function"));
    const latestFetch = response(config);
    const latest = monitor.configureMobileMonitoring("https://latest.example.com", {}, latestFetch);
    finishClose();
    await Promise.all([stale, latest]);
    expect(staleFetch).not.toHaveBeenCalled();
    expect(latestFetch).toHaveBeenCalledOnce();
  });

  it("does not replay a stored startup error after switching sessions", async () => {
    const persisted = await import("./startup-error");
    persisted.saveStartupError(new Error("previous account"), secureStorage, application);
    installErrorUtils();
    const monitor = await import("./monitoring");
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    monitor.resetMobileMonitoring();
    await monitor.configureMobileMonitoring(
      "https://other.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    expect(sdk.captureException).not.toHaveBeenCalled();
    expect(persisted.readStartupError(secureStorage)).toBeUndefined();
  });

  it("keeps the fatal path bounded when flushing fails and retains the report for retry", async () => {
    vi.useFakeTimers();
    const native = installErrorUtils();
    const monitor = await import("./monitoring");
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    sdk.flush.mockRejectedValueOnce(new Error("offline"));
    const error = new Error("fatal");
    native.handle(error, true);
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    await vi.waitFor(() => expect(native.previous).toHaveBeenCalledExactlyOnceWith(error, true));
    expect((await import("./startup-error")).readStartupError(secureStorage)?.error.message).toBe(
      "fatal",
    );
  });

  it("recovers Expo's latest persisted runtime error on the diagnostic channel", async () => {
    updates.channel = "diagnostic";
    updates.readLogEntriesAsync.mockResolvedValue([
      { code: "JSRuntimeError", level: "error", timestamp: 1, message: "older runtime failure" },
      {
        code: "JSRuntimeError",
        level: "error",
        timestamp: 2,
        message: "original recovery exception",
      },
      { code: "UpdateServerUnreachable", level: "error", timestamp: 3, message: "offline" },
    ]);
    const monitor = await import("./monitoring");
    storage.set("rakazo.api_base", "https://app.example.com");
    storage.set(
      "rakazo.expo-error-window",
      JSON.stringify({ server: "https://app.example.com", since: 1, reportedThrough: 0 }),
    );
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    await vi.waitFor(() =>
      expect(sdk.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "ExpoStartupError",
          message: "original recovery exception",
        }),
        {
          mechanism: { handled: false, type: "expo.error_recovery" },
          captureContext: {
            level: "fatal",
            tags: {
              operation: "mobile.startup",
              surface: "mobile",
              "startup.previous_launch": "true",
            },
          },
        },
      ),
    );
    expect(updates.readLogEntriesAsync).toHaveBeenCalledWith(3_600_000);
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      { Authorization: "Bearer example" },
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
    sdk.captureException.mockClear();
    vi.resetModules();
    const restarted = await import("./monitoring");
    restarted.installMobileEarlyErrorReporting(secureStorage, application);
    await restarted.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it.each(["read", "flush"])(
    "bounds diagnostic replay during a stuck %s and allows configuration to be replaced",
    async (step) => {
      vi.useFakeTimers();
      updates.channel = "diagnostic";
      const entries = [
        {
          code: "JSRuntimeError",
          level: "error",
          timestamp: Date.now(),
          message: "recoverable error",
        },
      ];
      updates.readLogEntriesAsync.mockResolvedValue(entries);
      if (step === "read") updates.readLogEntriesAsync.mockReturnValueOnce(new Promise(() => {}));
      else sdk.flush.mockReturnValueOnce(new Promise(() => {}));
      storage.set("rakazo.api_base", "https://app.example.com");
      const monitor = await import("./monitoring");
      monitor.installMobileEarlyErrorReporting(secureStorage, application);
      const first = monitor.configureMobileMonitoring(
        "https://app.example.com",
        {},
        response({ dsn: "https://key@errors.example.com/8" }),
      );
      await vi.waitFor(() => expect(updates.readLogEntriesAsync).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(2_000);
      await first;
      await monitor.configureMobileMonitoring(
        "https://app.example.com",
        { Authorization: "Bearer example" },
        response({ dsn: "https://key@errors.example.com/8" }),
      );
      expect(sdk.captureException).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: "recoverable error" }),
        expect.anything(),
      );
      // A second hanging read must be interrupted immediately by a server change, without
      // waiting for either its native promise or the two-second timeout.
      updates.readLogEntriesAsync.mockReturnValueOnce(new Promise(() => {}));
      const stuck = monitor.configureMobileMonitoring(
        "https://app.example.com",
        { Authorization: "Bearer changed" },
        response({ dsn: "https://key@errors.example.com/8" }),
      );
      await vi.waitFor(() => expect(updates.readLogEntriesAsync).toHaveBeenCalledTimes(3));
      const replacement = monitor.configureMobileMonitoring(
        "https://second.example.com",
        {},
        response({ dsn: "https://key@errors.example.com/8" }),
      );
      await Promise.all([stuck, replacement]);
      monitor.reportMobileError(new Error("current server"), "react.render");
      expect(sdk.captureException).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: "current server" }),
        expect.anything(),
      );
    },
  );

  it("does not recover unowned Expo errors or send the previous server's logs to a new server", async () => {
    updates.channel = "diagnostic";
    updates.readLogEntriesAsync.mockResolvedValue([
      {
        code: "JSRuntimeError",
        level: "error",
        timestamp: Date.now() - 100,
        message: "old server failure",
      },
    ]);
    const monitor = await import("./monitoring");
    storage.set("rakazo.api_base", "https://first.example.com");
    monitor.installMobileEarlyErrorReporting(secureStorage, application);
    await monitor.configureMobileMonitoring(
      "https://first.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    expect(sdk.captureException).not.toHaveBeenCalled();
    storage.set("rakazo.api_base", "https://second.example.com");
    monitor.resetMobileMonitoring();
    await monitor.configureMobileMonitoring(
      "https://second.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it("tags the open screen, including one opened before reporting started", async () => {
    const monitor = await import("./monitoring");
    monitor.setMobileMonitoringScreen("chat");
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    expect(sdk.setTag).toHaveBeenCalledWith("screen", "chat");
    monitor.setMobileMonitoringScreen("computer");
    expect(sdk.setTag).toHaveBeenLastCalledWith("screen", "computer");
    monitor.setMobileMonitoringScreen(undefined);
    expect(sdk.setTag).toHaveBeenLastCalledWith("screen", "other");
  });

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
    expect(updates.readLogEntriesAsync).not.toHaveBeenCalled();
    expect(options).toMatchObject({
      sendDefaultPii: false,
      enableLogs: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
    });
    const release = { name: "Release" };
    const handlers = { name: "ReactNativeErrorHandlers" };
    expect(options.integrations([release, handlers, { name: "DeviceContext" }])).toEqual([
      release,
      handlers,
    ]);
    expect(sdk.setTag).toHaveBeenCalledWith("mobile.platform", "ios");
    expect(
      options.beforeSend({ extra: { secret: "private" }, user: { email: "private" } }),
    ).toEqual({
      user: { id: "a".repeat(64), ip_address: null },
      tags: { "mobile.platform": "ios" },
    });
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

  it("keeps lost connections and cancelled requests out of error reports", async () => {
    const monitor = await import("./monitoring");
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8" }),
    );
    for (const message of [
      "fetch failed: UnexpectedException: The network connection was lost. (at ExpoModulesCore/Promise.swift:56)",
      "fetch failed: UnexpectedException: cancelled (at ExpoModulesCore/Promise.swift:56)",
      'fetch failed: java.net.UnknownHostException: Unable to resolve host "app.example.com": No address associated with hostname',
    ])
      monitor.reportMobileError(new Error(message), "rpc.transport");
    expect(sdk.captureException).not.toHaveBeenCalled();

    const bug = new TypeError("undefined is not a function");
    monitor.reportMobileError(bug, "rpc.transport");
    expect(sdk.captureException).toHaveBeenCalledWith(bug, {
      tags: { operation: "rpc.transport", surface: "mobile" },
    });

    const { beforeSend } = sdk.init.mock.calls[0]![0];
    const timeout = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    expect(beforeSend({}, { originalException: timeout })).toBeNull();
    expect(beforeSend({ level: "fatal" }, { originalException: timeout })).toEqual({
      level: "fatal",
      user: { ip_address: null },
      tags: { "mobile.platform": "ios" },
    });
    expect(beforeSend({}, { originalException: bug })).toEqual({
      user: { ip_address: null },
      tags: { "mobile.platform": "ios" },
    });
  });
});
