import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  currentState: "active",
  listener: undefined as ((state: string) => void) | undefined,
  remove: vi.fn(),
  report: vi.fn(),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return native.currentState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listener = listener;
      return { remove: native.remove };
    },
  },
}));
vi.mock("./monitoring", () => ({ reportMobileError: native.report }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  native.currentState = "active";
});
afterEach(() => vi.useRealTimers());

describe("mobile startup watchdog", () => {
  it("reports a silent stall before Router or an error boundary can mount", async () => {
    const startup = await import("./startup");
    startup.startMobileStartupWatchdog();
    startup.startMobileStartupWatchdog();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(native.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Mobile startup stalled: router" }),
      "mobile.startup",
    );
    expect(native.remove).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.report).toHaveBeenCalledOnce();
  });

  it("identifies the unresolved startup calls without counting background time", async () => {
    const startup = await import("./startup");
    startup.startMobileStartupWatchdog();
    startup.markMobileStartupMounted();
    void startup.trackMobileStartup("appearance", new Promise(() => {}));
    await startup.trackMobileStartup("server", Promise.resolve());
    await vi.advanceTimersByTimeAsync(5_000);
    native.listener!("background");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(native.report).not.toHaveBeenCalled();
    native.listener!("active");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(native.report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(native.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Mobile startup stalled: appearance" }),
      "mobile.startup",
    );
  });

  it("stops once the app or fallback becomes visible", async () => {
    const startup = await import("./startup");
    startup.startMobileStartupWatchdog();
    await vi.advanceTimersByTimeAsync(10_000);
    startup.completeMobileStartup();
    native.listener!("active");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.report).not.toHaveBeenCalled();
    expect(native.remove).toHaveBeenCalledOnce();
  });

  it("does not start the deadline until a background launch becomes active", async () => {
    native.currentState = "background";
    const startup = await import("./startup");
    startup.startMobileStartupWatchdog();
    startup.markMobileStartupMounted();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.report).not.toHaveBeenCalled();
    native.listener!("active");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(native.report).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Mobile startup stalled: render" }),
      "mobile.startup",
    );
  });

  it("reports rejected initialization before callers recover with defaults", async () => {
    const startup = await import("./startup");
    const error = new Error("Native initialization failed");
    await expect(startup.trackMobileStartup("language", Promise.reject(error))).rejects.toBe(error);
    expect(native.report).toHaveBeenCalledWith(error, "mobile.startup");
  });
});
