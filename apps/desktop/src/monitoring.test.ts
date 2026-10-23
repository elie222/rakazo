import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  send: vi.fn(async () => ({ statusCode: 200 })),
  flush: vi.fn(async () => true),
}));
const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
  IPCMode: { Classic: 1 },
  eventFiltersIntegration: vi.fn(),
  linkedErrorsIntegration: vi.fn(),
  dedupeIntegration: vi.fn(),
  onUncaughtExceptionIntegration: vi.fn(),
  makeElectronTransport: vi.fn(),
}));
vi.mock("@sentry/electron/main", () => sdk);
vi.mock("./native-crashes.js", () => ({
  configureNativeCrashReporting: vi.fn(),
  disableNativeCrashReporting: vi.fn(),
}));
afterEach(() => vi.useRealTimers());
const options = { version: "1.0.0", base: "https://app.example.com" };
const config = (body: unknown) => async () => new Response(JSON.stringify(body));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  sdk.init.mockImplementation((options) => options.transport({ url: "initial" }));
  sdk.makeElectronTransport.mockReturnValue(transport);
});

describe("desktop monitoring", () => {
  it("initializes observers once, switches transports, and disables reporting with the server", async () => {
    const monitor = await import("./monitoring.js");
    const error = new Error("startup");
    monitor.reportDesktopError(error, "desktop.startup");
    await monitor.configureDesktopMonitoring(
      config({ dsn: "https://key@errors.example.com/8", userId: "a".repeat(64) }),
      options,
    );
    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      tags: { operation: "desktop.startup", surface: "desktop", "monitoring.connection": 1 },
    });
    const initialized = sdk.init.mock.calls[0]![0];
    expect(initialized.getSessions()).toEqual([]);
    const hint = { attachments: [{ data: "private memory" }] };
    const event = initialized.beforeSend(
      { platform: "node", tags: { "monitoring.connection": 1, "native.crash": "true" } },
      hint,
    );
    expect(event.user).toEqual({ ip_address: null });
    expect(hint.attachments).toEqual([]);
    initialized.beforeSend(
      { event_id: "old-event", platform: "node", tags: { "monitoring.connection": 1 } },
      {},
    );
    const delegate = sdk.init.mock.results[0]!.value;
    await monitor.configureDesktopMonitoring(
      config({ dsn: "https://other@collector.example.com/9" }),
      { ...options, base: "https://other.example.com" },
    );
    expect(sdk.init).toHaveBeenCalledTimes(1);
    await delegate.send([{ event_id: "old-event" }, []]);
    expect(transport.send).not.toHaveBeenCalled();
    expect(sdk.makeElectronTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: "https://other.example.com/api/monitoring/native/desktop/api/0/envelope/?sentry_key=other",
      }),
    );
    expect(initialized.beforeSend({ tags: { "monitoring.connection": 1 } }, {})).toBeNull();
    await monitor.configureDesktopMonitoring(config({ dsn: null }), options);
    expect(initialized.beforeSend({}, {})).toBeNull();
  });

  it("accepts only the latest identity response when cookies change", async () => {
    const monitor = await import("./monitoring.js");
    await monitor.configureDesktopMonitoring(
      config({ dsn: "https://key@errors.example.com/8", userId: "a".repeat(64) }),
      options,
    );
    let release!: (response: Response) => void;
    const pending = monitor.refreshDesktopMonitoringUser(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await monitor.refreshDesktopMonitoringUser(
      config({ dsn: "https://key@errors.example.com/8", userId: "b".repeat(64) }),
    );
    release(
      new Response(
        JSON.stringify({ dsn: "https://key@errors.example.com/8", userId: "a".repeat(64) }),
      ),
    );
    await pending;
    const initialized = sdk.init.mock.calls[0]![0];
    expect(
      initialized.beforeSend({ platform: "node", tags: { "monitoring.connection": 1 } }, {}).user
        .id,
    ).toBe("b".repeat(64));
  });
  it("does not restore an initial identity after cookies changed during startup", async () => {
    const monitor = await import("./monitoring.js");
    let release!: (response: Response) => void;
    const initial = monitor.configureDesktopMonitoring(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      options,
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await monitor.refreshDesktopMonitoringUser(
      config({ dsn: "https://key@errors.example.com/8", userId: null }),
    );
    release(
      new Response(
        JSON.stringify({ dsn: "https://key@errors.example.com/8", userId: "a".repeat(64) }),
      ),
    );
    await initial;
    const initialized = sdk.init.mock.calls[0]![0];
    expect(
      initialized.beforeSend({ platform: "node", tags: { "monitoring.connection": 1 } }, {}).user,
    ).toEqual({ ip_address: null });
  });
  it("retries transient launch configuration failures without losing queued reports", async () => {
    vi.useFakeTimers();
    const monitor = await import("./monitoring.js");
    const fetchConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(config({ dsn: "https://key@errors.example.com/8" }));
    const error = new Error("queued startup failure");
    monitor.reportDesktopError(error, "desktop.startup");
    await monitor.configureDesktopMonitoring(fetchConfig, options);
    expect(sdk.init).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchConfig).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sdk.captureException).toHaveBeenCalledWith(error, expect.any(Object));
    expect(fetchConfig).toHaveBeenCalledTimes(3);
    monitor.disableDesktopMonitoring();
  });

  it("cancels retries and pending reports when a connection is replaced or disabled", async () => {
    vi.useFakeTimers();
    const monitor = await import("./monitoring.js");
    const failed = vi.fn(async () => new Response(null, { status: 503 }));
    await monitor.configureDesktopMonitoring(failed, options);
    monitor.reportDesktopError(new Error("old connection"), "desktop.startup");
    await monitor.configureDesktopMonitoring(config({ dsn: null }), {
      ...options,
      base: "https://other.example.com",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(sdk.init).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await monitor.configureDesktopMonitoring(failed, options);
    monitor.disableDesktopMonitoring();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).toHaveBeenCalledTimes(2);
  });
  it("identifies the current user when a retry recovers after cookie changes", async () => {
    vi.useFakeTimers();
    const monitor = await import("./monitoring.js");
    const fetchConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(
        config({ dsn: "https://key@errors.example.com/8", userId: "b".repeat(64) }),
      );
    await monitor.configureDesktopMonitoring(fetchConfig, options);
    await monitor.refreshDesktopMonitoringUser(
      config({ dsn: "https://key@errors.example.com/8", userId: "b".repeat(64) }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const initialized = sdk.init.mock.calls[0]![0];
    expect(
      initialized.beforeSend({ platform: "node", tags: { "monitoring.connection": 1 } }, {}).user
        .id,
    ).toBe("b".repeat(64));
    monitor.disableDesktopMonitoring();
  });
});
