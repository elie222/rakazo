import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  generation: 1,
  locked: false,
  onAppState: undefined as undefined | ((state: string) => void),
  onEvent: undefined as undefined | ((event: unknown) => void),
  lastResponse: null as unknown,
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
  getLastNotificationResponse: () => fake.lastResponse,
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
  fake.lastResponse = null;
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
  const orgBot = {
    id: "bot-org-b",
    spaceId: "space-org-b",
    name: "Other org caller",
    color: "",
    avatarSet: undefined,
  };
  const orgAnswerRpc = (callId: string) => [
    "threads/answerCall",
    { botId: orgBot.id, callId },
    {
      requestContext: expect.objectContaining({
        headers: expect.objectContaining({ "x-rakazo-space-id": orgBot.spaceId }),
      }),
    },
  ];
  it("answers a native call from a bot outside the active organization", async () => {
    stop = startIncomingCalls();
    await tick();
    // The account stream knows callers across every organization; spaces/list only the active one.
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-b" } }]);
    fake.native.incomingState.mockResolvedValue({
      token: "",
      actions: [
        { action: "answer", callId: "call-b", botId: orgBot.id, expiresAt: block().expiresAt },
      ],
    });
    fake.onAppState?.("active");
    await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-b")));
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-b", true);
  });
  it("answers a same-organization native call from the roster without waiting on the stream", async () => {
    stop = startIncomingCalls();
    await tick();
    // No stream event: the active-organization roster must be enough, with no five-second wait.
    fake.native.incomingState.mockResolvedValue({
      token: "",
      actions: [
        { action: "answer", callId: "call-roster", botId: bot.id, expiresAt: block().expiresAt },
      ],
    });
    fake.onAppState?.("active");
    await vi.waitFor(() =>
      expect(fake.rpc).toHaveBeenCalledWith(
        "threads/answerCall",
        { botId: bot.id, callId: "call-roster" },
        expect.anything(),
      ),
    );
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-roster", true);
  });
  it("answers a notification call from another organization once the stream reports it", async () => {
    fake.lastResponse = {
      actionIdentifier: "answer",
      notification: {
        request: { content: { data: { ...block(), kind: "incoming_call", botId: orgBot.id } } },
      },
    };
    stop = startIncomingCalls();
    await tick();
    // Cold start: the answer waits for the account stream's snapshot instead of failing
    // on the active organization's roster.
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-1" } }]);
    await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-1")));
  });
  it("abandons a cold-start notification answer when its session stops before the stream reports", async () => {
    fake.lastResponse = {
      actionIdentifier: "answer",
      notification: {
        request: { content: { data: { ...block(), kind: "incoming_call", botId: orgBot.id } } },
      },
    };
    stop = startIncomingCalls();
    await tick();
    // The answer is parked waiting for the account stream's first snapshot.
    stop?.();
    stop = undefined;
    // The app restarts under a new session and its stream reports the same ringing call.
    fake.generation++;
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-1" } }]);
    await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-1")));
    const answers = () => fake.rpc.mock.calls.filter((call) => call[0] === "threads/answerCall");
    expect(answers()).toHaveLength(1);
    // The stopped session's wait must not wake after its window and re-answer or fail the action.
    await vi.advanceTimersByTimeAsync(5100);
    expect(answers()).toHaveLength(1);
    expect(fake.native.finishAnswer).not.toHaveBeenCalledWith("call-1", false);
  });
  it("answers a caller the stream names without waiting for a slow roster", async () => {
    const expiresAt = new Date(Date.now() + 3000).toISOString();
    const answer = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === "spaces/list") await new Promise((resolve) => setTimeout(resolve, 4000));
      return answer(path, ...rest);
    });
    fake.lastResponse = {
      actionIdentifier: "answer",
      notification: {
        request: {
          content: { data: { ...block(), expiresAt, kind: "incoming_call", botId: orgBot.id } },
        },
      },
    };
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), expiresAt } }]);
    await vi.advanceTimersByTimeAsync(5100);
    expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-1"));
  });
  it("answers a caller the stream names while a slow roster loads after an empty snapshot", async () => {
    const answer = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === "spaces/list") await new Promise((resolve) => setTimeout(resolve, 4000));
      return answer(path, ...rest);
    });
    fake.lastResponse = {
      actionIdentifier: "answer",
      notification: {
        request: { content: { data: { ...block(), kind: "incoming_call", botId: orgBot.id } } },
      },
    };
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([]);
    await vi.advanceTimersByTimeAsync(1000);
    fake.onEvent?.([{ ...orgBot, incomingCall: block() }]);
    await vi.advanceTimersByTimeAsync(4100);
    expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-1"));
  });
  it("answers a caller the stream names after an empty snapshot when the roster load fails", async () => {
    const answer = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === "spaces/list") {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        throw new Error("offline");
      }
      return answer(path, ...rest);
    });
    fake.lastResponse = {
      actionIdentifier: "answer",
      notification: {
        request: { content: { data: { ...block(), kind: "incoming_call", botId: orgBot.id } } },
      },
    };
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([]);
    await vi.advanceTimersByTimeAsync(1000);
    fake.onEvent?.([{ ...orgBot, incomingCall: block() }]);
    await vi.advanceTimersByTimeAsync(4100);
    expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-1"));
  });
  it("ignores a frame from a stopped feed while a restarted feed's answer waits", async () => {
    stop = startIncomingCalls();
    await tick();
    const stale = fake.onEvent!;
    stop?.();
    fake.lastResponse = {
      actionIdentifier: "answer",
      notification: {
        request: { content: { data: { ...block(), kind: "incoming_call", botId: orgBot.id } } },
      },
    };
    stop = startIncomingCalls();
    await tick();
    // The old read was mid-chunk when its feed stopped; its frame predates the call.
    stale([]);
    await tick();
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-1" } }]);
    await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-1")));
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
