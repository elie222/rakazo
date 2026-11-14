import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  startWorkActivity: vi.fn(async () => undefined),
  refreshWorkActivity: vi.fn(async () => undefined),
  endWorkActivity: vi.fn(async () => undefined),
  token: undefined as undefined | ((event: { token: string }) => void),
  startToken: undefined as undefined | ((event: { token: string }) => void),
  addListener(name: string, callback: (event: { token: string }) => void) {
    if (name === "onWorkActivityStartToken") native.startToken = callback;
    else native.token = callback;
    return { remove() {} };
  },
}));
const app = vi.hoisted(() => ({
  appState: undefined as undefined | ((state: string) => void),
  session: undefined as undefined | (() => void),
  token: "session-token",
  generation: 1,
  ready: 1,
  readFails: false,
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
  currentSessionGeneration: () => app.generation,
  currentReadySessionGeneration: () => app.ready,
  snapshotSessionToken: async () =>
    app.readFails ? { ok: false } : { ok: true, value: app.token },
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
  rpc.mockReset();
  app.token = "session-token";
  app.generation = 1;
  app.ready = 1;
  app.readFails = false;
});

it("starts the card for the chat just sent to only after the server confirms support", async () => {
  let reply!: (value: { following: boolean }) => void;
  rpc.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
  startWorkActivity({ title: "Planner", spaceId: "space-1", target: { groupId: "group-1" } });
  expect(rpc).toHaveBeenCalledWith("notifications/followWorkActivity", {});
  expect(native.startWorkActivity).not.toHaveBeenCalled();
  reply({ following: true });
  await settle();
  expect(native.startWorkActivity).toHaveBeenCalledWith("Planner", "space-1", null, "group-1");
});

it("skips creating a card when the server cannot follow it", async () => {
  rpc.mockResolvedValueOnce({ following: false });
  startWorkActivity({ title: "Planner", spaceId: "space-1", target: { botId: "bot-1" } });
  await settle();
  expect(native.startWorkActivity).not.toHaveBeenCalled();
  expect(native.endWorkActivity).not.toHaveBeenCalled();
});

it.each(["unsupported preflight", "offline"])("skips creating a card on %s", async (message) => {
  rpc.mockRejectedValueOnce(new Error(message));
  startWorkActivity({ title: "Planner", spaceId: "space-1", target: { botId: "bot-1" } });
  await settle();
  expect(native.startWorkActivity).not.toHaveBeenCalled();
  expect(native.endWorkActivity).not.toHaveBeenCalled();
});

it("ignores preflight support from a previous session", async () => {
  let reply!: (value: { following: boolean }) => void;
  rpc.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
  startWorkActivity({ title: "Planner", spaceId: "space-1", target: { botId: "bot-1" } });
  app.generation += 1;
  reply({ following: true });
  await settle();
  expect(native.startWorkActivity).not.toHaveBeenCalled();
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

  // A reply that lands after the account changed is ignored.
  let reply!: (value: { following: boolean }) => void;
  rpc.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
  native.token!({ token: "ab" });
  app.generation += 1;
  reply({ following: false });
  await settle();
  expect(native.endWorkActivity).not.toHaveBeenCalled();

  rpc.mockResolvedValueOnce({ following: false });
  native.token!({ token: "ab" });
  await settle();
  expect(native.endWorkActivity).toHaveBeenCalledOnce();
});

it("hands the phone's token for starting cards to the server", async () => {
  rpc.mockResolvedValueOnce({ ok: true });
  native.startToken!({ token: "cd" });
  await settle();
  expect(rpc).toHaveBeenCalledWith("notifications/registerWorkActivityStarts", { token: "cd" });
  // A failed request is asked again on the next open.
  rpc.mockRejectedValueOnce(new Error("offline"));
  native.startToken!({ token: "cd" });
  await settle();
});

it("asks again on launch and whenever the app opens, and ends the card on sign-out", async () => {
  startWorkActivities();
  expect(native.refreshWorkActivity).toHaveBeenCalledOnce();
  native.refreshWorkActivity.mockClear();
  app.appState!("background");
  app.appState!("active");
  expect(native.refreshWorkActivity).toHaveBeenCalledOnce();

  native.refreshWorkActivity.mockClear();
  app.session!();
  await settle();
  expect(native.endWorkActivity).not.toHaveBeenCalled();
  // A new sign-in hands both tokens to its session.
  expect(native.refreshWorkActivity).toHaveBeenCalledOnce();
  app.token = "";
  // A change still landing, or a keychain read that failed, is not a sign-out.
  app.ready = 0;
  app.session!();
  app.ready = 1;
  app.readFails = true;
  app.session!();
  await settle();
  expect(native.endWorkActivity).not.toHaveBeenCalled();
  app.readFails = false;
  app.session!();
  await settle();
  expect(native.endWorkActivity).toHaveBeenCalledOnce();
});
