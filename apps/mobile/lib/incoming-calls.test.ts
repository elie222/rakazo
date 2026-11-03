import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  generation: 1,
  locked: false,
  onAppState: undefined as undefined | ((state: string) => void),
  onEvent: undefined as undefined | ((event: unknown) => void),
  actions: [] as Record<string, string>[],
  native: {
    incomingState: vi.fn(),
    addListener: () => ({ remove() {} }),
    endIncomingCall: vi.fn(async () => {}),
    finishAnswer: vi.fn(async () => {}),
    clearIncomingCalls: vi.fn(async () => {}),
    configureIncomingSession: vi.fn(async () => {}),
    reportIncomingCall: vi.fn(async () => {}),
  },
  rpc: vi.fn(),
  startCall: vi.fn(),
  call: null as unknown,
}));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => fake.native }));
vi.mock("expo-notifications", () => ({
  setNotificationCategoryAsync: async () => {},
  getLastNotificationResponse: () => null,
  addNotificationResponseReceivedListener: () => ({ remove() {} }),
  addNotificationReceivedListener: () => ({ remove() {} }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, callback: (state: string) => void) => {
      fake.onAppState = callback;
      return { remove() {} };
    },
  },
}));
vi.mock("./api", () => ({
  loadSessionToken: async () => "fake-session",
  captureApiRequestContext: async (spaceId: string) => ({
    apiBase: "https://example.invalid",
    headers: {
      "x-rakazo-space-id": spaceId,
      ...(fake.locked ? {} : { authorization: "Bearer fake-session" }),
    },
    sessionGeneration: fake.generation,
  }),
  rpc: fake.rpc,
  subscribeIncomingCallEvents: async (onEvent: (event: unknown) => void, signal: AbortSignal) => {
    fake.onEvent = onEvent;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  },
}));
vi.mock("./call-session", () => ({
  endCall: vi.fn(),
  getSnapshot: () => fake.call,
  startCall: fake.startCall,
  subscribe: () => () => {},
}));
vi.mock("./i18n", () => ({ t: (value: string) => value }));
vi.mock("./push", () => ({ registerCallPushToken: vi.fn() }));
vi.mock("./server-headers", () => ({ serverHeaders: () => ({}) }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => fake.generation,
  registerSessionDiskCache: vi.fn(),
}));

import { endCall } from "./call-session";
import {
  getIncomingCall,
  respondToMobileCall,
  startIncomingCalls,
  stopIncomingCalls,
} from "./incoming-calls";

const bot = { id: "bot-1", spaceId: "space-1", name: "Caller", color: "", avatarSet: undefined };
const block = () => ({
  kind: "call_request",
  status: "ringing",
  callId: "call-1",
  expiresAt: new Date(Date.now() + 45000).toISOString(),
  opening: "Hello",
  reason: "Review",
});
const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  fake.generation = 1;
  fake.locked = false;
  fake.onAppState = undefined;
  fake.onEvent = undefined;
  fake.call = null;
  vi.clearAllMocks();
  fake.native.incomingState.mockResolvedValue({ token: "", actions: [] });
  fake.rpc.mockImplementation(async (path: string) => {
    if (path === "spaces/list") return { current: { bots: [bot] }, spaces: [] };
    if (path === "threads/get") return { cursor: 1, messages: [] };
    if (path === "threads/answerCall") return { opening: "Hello" };
    if (path === "voice/status") return { transcribe: true };
    return { ok: true };
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  stopIncomingCalls();
  vi.useRealTimers();
});
async function ring() {
  stop = startIncomingCalls();
  await tick();
  fake.onEvent?.([{ ...bot, incomingCall: block() }]);
  return getIncomingCall()!;
}
describe("mobile incoming calls", () => {
  it("waits for unlock before configuring credentials and opening the account stream", async () => {
    fake.locked = true;
    stop = startIncomingCalls();
    await tick();
    expect(fake.onEvent).toBeUndefined();
    expect(fake.native.configureIncomingSession).not.toHaveBeenCalled();
    fake.locked = false;
    fake.onAppState?.("active");
    await tick();
    expect(fake.onEvent).toBeTypeOf("function");
    expect(fake.native.configureIncomingSession).toHaveBeenCalledOnce();
  });
  it("rings from realtime and expires without polling", async () => {
    await ring();
    expect(getIncomingCall()?.incomingCall.callId).toBe("call-1");
    const requests = fake.rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(45000);
    expect(getIncomingCall()).toBeNull();
    expect(fake.rpc).toHaveBeenCalledTimes(requests);
  });
  it("answers with the existing call id, opening, Space and session", async () => {
    const call = await ring();
    await respondToMobileCall(call, "answer");
    expect(fake.startCall).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: bot.id,
        greeting: "Hello",
        answered: { callId: "call-1" },
        session: 1,
        requestContext: expect.objectContaining({
          headers: expect.objectContaining({ "x-rakazo-space-id": "space-1" }),
        }),
      }),
    );
    expect(getIncomingCall()).toBeNull();
  });
  it("ends the current call when a native answer arrives during it", async () => {
    await ring();
    fake.call = { botId: "bot-2" };
    fake.native.incomingState.mockResolvedValue({
      token: "",
      actions: [
        { action: "answer", callId: "call-1", botId: bot.id, expiresAt: block().expiresAt },
      ],
    });
    fake.onAppState?.("active");
    await vi.waitFor(() => expect(fake.startCall).toHaveBeenCalled());
    expect(endCall).toHaveBeenCalled();
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-1", true);
  });
  it("declines through the same backend path as web", async () => {
    await respondToMobileCall(await ring(), "decline");
    expect(fake.rpc).toHaveBeenCalledWith(
      "notifications/declineIncomingCall",
      { callId: "call-1" },
      expect.anything(),
    );
    expect(fake.startCall).not.toHaveBeenCalled();
  });
  it("hangs up instead of starting audio when the session changes while answering", async () => {
    const call = await ring();
    fake.rpc.mockImplementation(async (path: string) => {
      if (path === "threads/answerCall") {
        fake.generation++;
        return { opening: "Hello" };
      }
      return {};
    });
    await expect(respondToMobileCall(call, "answer")).rejects.toThrow();
    expect(fake.startCall).not.toHaveBeenCalled();
    expect(fake.rpc).toHaveBeenCalledWith(
      "threads/endCall",
      { botId: call.id, callId: call.incomingCall.callId },
      expect.anything(),
    );
  });
  it("stops ringing when another device answers", async () => {
    await ring();
    fake.onEvent?.([]);
    expect(getIncomingCall()).toBeNull();
    expect(fake.native.endIncomingCall).toHaveBeenCalledWith("call-1");
  });
});
