import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  startWorkActivity: vi.fn(async () => undefined),
  refreshWorkActivity: vi.fn(async () => undefined),
  endWorkActivity: vi.fn(async () => undefined),
  token: undefined as undefined | ((event: { token: string }) => void),
  addListener(_name: string, callback: (event: { token: string }) => void) {
    native.token = callback;
    return { remove() {} };
  },
}));
const app = vi.hoisted(() => ({
  appState: undefined as undefined | ((state: string) => void),
  session: undefined as undefined | (() => void),
  token: "session-token",
}));
const rpc = vi.hoisted(() => vi.fn());

vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => native }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    addEventListener: (_name: string, callback: (state: string) => void) => {
      app.appState = callback;
      return { remove() {} };
    },
  },
}));
vi.mock("./api", () => ({ rpc }));
vi.mock("./session", () => ({
  loadSessionToken: async () => app.token,
  subscribeSessionGeneration: (listener: () => void) => {
    app.session = listener;
    return () => undefined;
  },
}));

const { startWorkActivities, startWorkActivity } = await import("./work-activity");
startWorkActivities();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  app.token = "session-token";
});

it("starts the card for the chat just sent to", () => {
  startWorkActivity({ title: "Planner", spaceId: "space-1", target: { groupId: "group-1" } });
  expect(native.startWorkActivity).toHaveBeenCalledWith("Planner", "space-1", null, "group-1");
});

it("ends the card only when the server says nothing would update it", async () => {
  rpc.mockResolvedValueOnce({ following: true });
  native.token!({ token: "ab" });
  await settle();
  expect(rpc).toHaveBeenCalledWith("notifications/followWorkActivity", { token: "ab" });
  expect(native.endWorkActivity).not.toHaveBeenCalled();

  rpc.mockRejectedValueOnce(new Error("offline"));
  native.token!({ token: "ab" });
  await settle();
  expect(native.endWorkActivity).not.toHaveBeenCalled();

  rpc.mockResolvedValueOnce({ following: false });
  native.token!({ token: "ab" });
  await settle();
  expect(native.endWorkActivity).toHaveBeenCalledOnce();
});

it("asks again on launch and whenever the app opens, and ends the card on sign-out", async () => {
  startWorkActivities();
  expect(native.refreshWorkActivity).toHaveBeenCalledOnce();
  native.refreshWorkActivity.mockClear();
  app.appState!("background");
  app.appState!("active");
  expect(native.refreshWorkActivity).toHaveBeenCalledOnce();

  app.session!();
  await settle();
  expect(native.endWorkActivity).not.toHaveBeenCalled();
  app.token = "";
  app.session!();
  await settle();
  expect(native.endWorkActivity).toHaveBeenCalledOnce();
});
