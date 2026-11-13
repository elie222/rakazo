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
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api", () => ({
  captureApiRequestContext: async (spaceId: string) => ({
    apiBase: "https://example.invalid",
    headers: {
      "x-rakazo-space-id": spaceId,
      ...(fake.locked ? {} : { authorization: "Bearer fake-session" }),
    },
    sessionGeneration: fake.generation,
  }),
  rpc: fake.rpc,
}));
vi.mock("./api-live", () => ({
  subscribeIncomingCallEvents: async (onEvent: (event: unknown) => void, signal: AbortSignal) => {
    fake.onEvent = onEvent;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  },
}));
vi.mock("./call-session", () => ({
  endCall: vi.fn(),
  hangUp: vi.fn(),
  getSnapshot: () => fake.call,
  startCall: fake.startCall,
  subscribe: () => () => {},
}));
vi.mock("./push", () => ({ registerCallPushToken: vi.fn() }));
vi.mock("./server-headers", () => ({ serverHeaders: () => ({}) }));
vi.mock("./session", () => ({
  loadSessionToken: async () => "fake-session",

  currentSessionGeneration: () => fake.generation,
  registerSessionDiskCache: vi.fn(),
}));

import { endCall, hangUp } from "./call-session";
import {
  endedStreamCallCount,
  getIncomingCall,
  respondToMobileCall,
  startIncomingCalls,
  stopIncomingCalls,
} from "./incoming-calls";
import { registerCallPushToken } from "./push";

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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let stop: (() => void) | undefined;
beforeEach(() => {
  // Retry and reconnect waits are jittered; pin them to their unjittered values.
  vi.spyOn(Math, "random").mockReturnValue(0);
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
  it("keeps ambiguous native end events on the silent teardown path", async () => {
    await respondToMobileCall(await ring(), "answer");
    fake.call = { botId: bot.id };
    fake.native.incomingState.mockResolvedValue({
      token: "",
      actions: [{ action: "end", callId: "call-1", botId: bot.id, expiresAt: block().expiresAt }],
    });
    fake.onAppState?.("active");
    await vi.waitFor(() => expect(endCall).toHaveBeenCalledOnce());
    expect(hangUp).not.toHaveBeenCalled();
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
  it("answers a native call without waiting for VoIP token registration", async () => {
    let settled = false;
    let releaseRegistration = () => undefined;
    vi.mocked(registerCallPushToken).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseRegistration = () => {
            settled = true;
            resolve();
          };
        }),
    );
    fake.native.incomingState.mockResolvedValue({
      token: "voip-token",
      actions: [
        { action: "answer", callId: "call-roster", botId: bot.id, expiresAt: block().expiresAt },
      ],
    });
    stop = startIncomingCalls();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.rpc).toHaveBeenCalledWith(
      "threads/answerCall",
      { botId: bot.id, callId: "call-roster" },
      expect.anything(),
    );
    expect(vi.mocked(registerCallPushToken).mock.invocationCallOrder[0]).toBeGreaterThan(
      fake.rpc.mock.invocationCallOrder[0],
    );
    expect(settled).toBe(false);
    releaseRegistration();
  });
  const pendingNativeAnswer = (expiresAt = block().expiresAt) =>
    fake.native.incomingState.mockResolvedValue({
      token: "",
      actions: [{ action: "answer", callId: "call-b", botId: orgBot.id, expiresAt }],
    });
  it("answers a pending native call the stream names when the roster load fails", async () => {
    const answer = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === "spaces/list") throw new Error("offline");
      return answer(path, ...rest);
    });
    pendingNativeAnswer();
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-b" } }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-b"));
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-b", true);
  });
  it("answers a pending native call the stream names without waiting for a slow roster", async () => {
    const expiresAt = new Date(Date.now() + 3000).toISOString();
    const answer = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === "spaces/list") await new Promise((resolve) => setTimeout(resolve, 4000));
      return answer(path, ...rest);
    });
    pendingNativeAnswer(expiresAt);
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-b", expiresAt } }]);
    await vi.advanceTimersByTimeAsync(5100);
    expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-b"));
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-b", true);
    expect(fake.native.finishAnswer).not.toHaveBeenCalledWith("call-b", false);
  });
  it("answers a pending native call before loading the roster for another ringing call", async () => {
    const expiresAt = new Date(Date.now() + 3000).toISOString();
    const answer = fake.rpc.getMockImplementation()!;
    let lists = 0;
    fake.rpc.mockImplementation(async (path: string, ...rest: unknown[]) => {
      // The refresh's roster load is quick; the ringing call's own load outlasts the answer's ring.
      if (path === "spaces/list" && ++lists > 1)
        await new Promise((resolve) => setTimeout(resolve, 4000));
      return answer(path, ...rest);
    });
    fake.native.incomingState.mockResolvedValue({
      token: "",
      ringing: [{ callId: "call-x", botId: "bot-unknown", expiresAt: block().expiresAt }],
      actions: [{ action: "answer", callId: "call-b", botId: orgBot.id, expiresAt }],
    });
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-b", expiresAt } }]);
    await vi.advanceTimersByTimeAsync(5100);
    expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-b"));
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-b", true);
    expect(fake.native.finishAnswer).not.toHaveBeenCalledWith("call-b", false);
  });
  it("does not bring back a ringing call a newer snapshot ended while an answer joins", async () => {
    const answering = deferred<{ opening: string }>();
    const answer = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === "threads/answerCall") return answering.promise;
      return answer(path, ...rest);
    });
    const other = { ...block(), callId: "call-x" };
    fake.native.incomingState.mockResolvedValue({
      token: "",
      ringing: [{ callId: "call-x", botId: bot.id, expiresAt: other.expiresAt }],
      actions: [
        { action: "answer", callId: "call-b", botId: orgBot.id, expiresAt: block().expiresAt },
      ],
    });
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([
      { ...orgBot, incomingCall: { ...block(), callId: "call-b" } },
      { ...bot, incomingCall: other },
    ]);
    await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-b")));
    // Another phone answers the other call; the stream's next snapshot no longer lists it.
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-b" } }]);
    answering.resolve({ opening: "Hello" });
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-b", true);
    expect(getIncomingCall()).toBeNull();
  });
  it("shows a new native ring when an older empty snapshot arrives during the native read", async () => {
    const reading = deferred<{ token: string; actions: never[]; ringing: unknown[] }>();
    fake.native.incomingState.mockReturnValue(reading.promise);
    stop = startIncomingCalls();
    await tick();
    // A snapshot fetched before the call existed lands while the native state is read.
    fake.onEvent?.([]);
    const ring = { ...block(), callId: "call-new" };
    reading.resolve({
      token: "",
      actions: [],
      ringing: [{ callId: "call-new", botId: bot.id, expiresAt: ring.expiresAt }],
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(getIncomingCall()?.incomingCall.callId).toBe("call-new");
  });
  it("forgets ended calls once their ring would have expired", async () => {
    stop = startIncomingCalls();
    await tick();
    for (let i = 0; i < 50; i++) {
      const ring = {
        ...block(),
        callId: `call-${i}`,
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      };
      fake.onEvent?.([{ ...bot, incomingCall: ring }]);
      fake.onEvent?.([]);
    }
    expect(endedStreamCallCount()).toBe(50);
    await vi.advanceTimersByTimeAsync(1100);
    fake.onEvent?.([]);
    expect(endedStreamCallCount()).toBe(0);
  });
  it("takes over a native ring the app shows only after it became active", async () => {
    stop = startIncomingCalls();
    await tick();
    const ring = { ...block(), callId: "call-x" };
    fake.native.incomingState.mockResolvedValue({
      token: "",
      actions: [],
      ringing: [{ callId: "call-x", botId: bot.id, expiresAt: ring.expiresAt }],
    });
    // Android: the app comes to the foreground before the stream reports this ring.
    fake.onAppState?.("active");
    await vi.advanceTimersByTimeAsync(100);
    expect(getIncomingCall()?.incomingCall.callId).toBe("call-x");
    // The in-app screen rings now, so the native notification must stop.
    expect(fake.native.endIncomingCall).toHaveBeenCalledWith("call-x");
  });
  it("takes over a native ring shown after a pending answer joins", async () => {
    const answering = deferred<{ opening: string }>();
    const answer = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === "threads/answerCall") return answering.promise;
      return answer(path, ...rest);
    });
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-b" } }]);
    fake.native.incomingState.mockResolvedValue({
      token: "",
      ringing: [{ callId: "call-x", botId: bot.id, expiresAt: block().expiresAt }],
      actions: [
        { action: "answer", callId: "call-b", botId: orgBot.id, expiresAt: block().expiresAt },
      ],
    });
    fake.onAppState?.("active");
    await vi.waitFor(() => expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-b")));
    answering.resolve({ opening: "Hello" });
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.native.endIncomingCall).toHaveBeenCalledWith("call-x");
  });
  it("shares one roster request between a refresh and a ringing call", async () => {
    const answer = fake.rpc.getMockImplementation()!;
    let inFlight = 0;
    let most = 0;
    fake.rpc.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path !== "spaces/list") return answer(path, ...rest);
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      inFlight -= 1;
      return answer(path, ...rest);
    });
    fake.native.incomingState.mockResolvedValue({
      token: "",
      ringing: [{ callId: "call-x", botId: "bot-unknown", expiresAt: block().expiresAt }],
      actions: [],
    });
    stop = startIncomingCalls();
    await vi.advanceTimersByTimeAsync(1100);
    expect(most).toBe(1);
  });
  it("fails one native answer whose caller cannot be found and still answers the next", async () => {
    const answer = fake.rpc.getMockImplementation()!;
    fake.rpc.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path === "spaces/list") throw new Error("offline");
      return answer(path, ...rest);
    });
    const expiresAt = block().expiresAt;
    fake.native.incomingState.mockResolvedValue({
      token: "",
      ringing: [{ callId: "call-x", botId: "bot-unknown", expiresAt }],
      actions: [
        { action: "answer", callId: "call-x", botId: "bot-unknown", expiresAt },
        { action: "answer", callId: "call-b", botId: orgBot.id, expiresAt },
      ],
    });
    stop = startIncomingCalls();
    await tick();
    fake.onEvent?.([{ ...orgBot, incomingCall: { ...block(), callId: "call-b" } }]);
    await vi.advanceTimersByTimeAsync(5100);
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-x", false);
    expect(fake.rpc).toHaveBeenCalledWith(...orgAnswerRpc("call-b"));
    expect(fake.native.finishAnswer).toHaveBeenCalledWith("call-b", true);
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
