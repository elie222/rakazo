import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  storedBase: "https://selected.example.com",
  importBroken: true,
  configure: vi.fn(async () => {}),
  report: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({ getItem: () => state.storedBase }));
vi.mock("react-native", () => ({ AppState: { addEventListener: vi.fn() } }));
vi.mock("./monitoring", () => ({
  configureMobileMonitoring: state.configure,
  reportMobileError: state.report,
  resetMobileMonitoring: vi.fn(),
}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => {
  if (state.importBroken) throw new Error("app import failed");
  return {
    authHeaders: async () => ({ authorization: "Bearer fake-session" }),
    currentApiBase: () => state.storedBase,
    subscribeApiBase: state.subscribe,
  };
});
vi.mock("./api-server", () => {
  if (state.importBroken) throw new Error("app import failed");
  return { loadApiBase: async () => state.storedBase };
});
vi.mock("./session", () => ({
  currentSessionGeneration: () => 0,
  subscribeSessionGeneration: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.importBroken = true;
  state.configure.mockResolvedValue(undefined);
});

describe("early monitoring bootstrap", () => {
  it("requests configuration on the selected server even when the app graph cannot load", async () => {
    const { startMobileMonitoring } = await import("./monitoring-bootstrap");
    startMobileMonitoring();
    expect(state.configure).toHaveBeenCalledWith(state.storedBase, {});
    await vi.waitFor(() =>
      expect(state.report).toHaveBeenCalledWith(expect.any(Error), "mobile.startup"),
    );
  });

  it("attaches session resets without waiting for the anonymous configuration request", async () => {
    state.importBroken = false;
    state.configure.mockImplementation(() => new Promise(() => {}));
    const { startMobileMonitoring } = await import("./monitoring-bootstrap");
    startMobileMonitoring();
    await vi.waitFor(() => expect(state.subscribe).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(state.configure).toHaveBeenCalledWith(state.storedBase, {
        authorization: "Bearer fake-session",
      }),
    );
  });
});
