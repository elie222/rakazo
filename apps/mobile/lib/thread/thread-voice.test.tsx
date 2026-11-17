// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequestContext } from "../api/api";
import { captureApiRequestContext, rpc } from "../api/api";
import type { MobileBot, MobileMessage, MobileSnapshot } from "../api/mobile-types";
import { blockText } from "../api/mobile-types";
import { clearSessionToken, currentSessionGeneration, saveSessionToken } from "../api/session";
import type { CallState } from "../calls/call-session";
import { getSnapshot as getCallSnapshot, startCall } from "../calls/call-session";
import { loadCallGreetingEnabled } from "../calls/call-sounds";
import { takeShortcutVoiceChat } from "../calls/voice-chat-intent";
import { loadDeviceVoiceEnabled } from "../voice/device-voice";
import { speakQueue, speakText } from "../voice/voice";
import { useAutoSpeakReply, useSpeakMessages, useThreadVoiceCall } from "./thread-voice";

const apiScope = vi.hoisted(() => ({
  apiBase: "https://api.example.test",
  spaceId: "space-riley",
  selectionGeneration: 0,
}));
const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("expo-router", () => ({
  useNavigation: () => ({ isFocused: () => true }),
  useRouter: () => navigation,
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: { currentState: "active", addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("../notifications/live-notifications", () => ({
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./send/thread-feedback", () => ({ clearFailedSends: vi.fn() }));
vi.mock("../api/network-cache", () => ({ clearNetworkCache: vi.fn() }));
// Signed out, every request fails; device voice needs none of them to start the microphone.
vi.mock("../api/mobile-types", () => ({
  blockText: vi.fn(),
}));
vi.mock("../api/api", () => ({
  currentApiBase: () => apiScope.apiBase,
  selectedSpaceId: () => apiScope.spaceId,
  currentSpaceSelectionGeneration: () => apiScope.selectionGeneration,
  captureApiRequestContext: vi.fn(),
  rpc: vi.fn(async () => {
    throw new Error("Unauthorized");
  }),
}));
vi.mock("../calls/call-session", () => ({
  getSnapshot: vi.fn((): null => null),
  setCallProviderTranscribe: vi.fn(),
  startCall: vi.fn(() => "call-1"),
}));
vi.mock("../calls/call-sounds", () => ({ loadCallGreetingEnabled: vi.fn(async () => true) }));
vi.mock("../voice/device-voice", () => ({ loadDeviceVoiceEnabled: vi.fn(async () => true) }));
vi.mock("../voice/dictation", () => ({ available: async () => true }));
vi.mock("../voice/voice", () => ({
  speakQueue: vi.fn(async () => true),
  speakText: vi.fn(async () => true),
}));
vi.mock("../calls/voice-chat-intent", () => ({
  onShortcutVoiceChat: () => () => undefined,
  takeShortcutVoiceChat: vi.fn(() => false),
}));

const riley = { id: "riley", name: "Riley" } as MobileBot;
const max = { id: "max", name: "Max" } as MobileBot;
const bots = [riley, max];

describe("useThreadVoiceCall hand-over", () => {
  let root: Root;
  let openBotChat: ((target: MobileBot, ring: boolean) => void) | undefined;
  let startVoiceCall: (() => Promise<void>) | undefined;

  function render(botId: string) {
    function Thread() {
      const voiceCall = useThreadVoiceCall({
        botId,
        readOnly: false,
        displayName: bots.find((bot) => bot.id === botId)?.name,
        mentionBots: bots,
        mentionBotsRef: { current: bots },
        activeBotId: { current: botId },
      });
      openBotChat = voiceCall.openBotChat;
      startVoiceCall = voiceCall.startVoiceCall;
      return null;
    }
    act(() => root.render(createElement(Thread, { key: botId })));
  }

  async function flush() {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(startCall).mockClear();
    vi.mocked(takeShortcutVoiceChat).mockReset().mockReturnValue(false);
    vi.mocked(loadCallGreetingEnabled).mockReset().mockResolvedValue(true);
    vi.mocked(loadDeviceVoiceEnabled).mockResolvedValue(true);
    vi.mocked(rpc).mockReset().mockRejectedValue(new Error("Unauthorized"));
    navigation.push.mockClear();
    navigation.replace.mockClear();
    apiScope.apiBase = "https://api.example.test";
    apiScope.spaceId = "space-riley";
    apiScope.selectionGeneration = 0;
    vi.mocked(captureApiRequestContext)
      .mockReset()
      .mockImplementation(
        async (spaceId = apiScope.spaceId): Promise<ApiRequestContext> => ({
          apiBase: apiScope.apiBase,
          headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
          sessionGeneration: currentSessionGeneration(),
        }),
      );
    await saveSessionToken("fake-token-a");
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("rings the bot the caller was put through to in the same session", async () => {
    render("riley");
    const session = currentSessionGeneration();
    openBotChat?.(max, true);
    render("max");
    await flush();

    expect(startCall).toHaveBeenCalledOnce();
    expect(startCall).toHaveBeenCalledWith(expect.objectContaining({ botId: "max", session }));
  });

  it("starts a shortcut call with a fresh greeting", async () => {
    vi.mocked(takeShortcutVoiceChat).mockReturnValueOnce(true);
    render("riley");
    await flush();
    expect(startCall).toHaveBeenCalledOnce();
    expect(startCall).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "riley", greeting: "Hello, Riley here." }),
    );
  });
  it("starts an outgoing call pinned to the Space it starts in", async () => {
    render("riley");
    await act(async () => {
      await startVoiceCall?.();
    });
    expect(startCall).toHaveBeenCalledOnce();
    // Switching organization or Space mid-call must not move the call's turns or hang-up
    // to another Space, so the call starts with the Space captured here.
    expect(startCall).toHaveBeenCalledWith(
      expect.objectContaining({
        requestContext: expect.objectContaining({
          headers: expect.objectContaining({ "x-rakazo-space-id": "space-riley" }),
        }),
      }),
    );
    const requestContext = await vi.mocked(captureApiRequestContext).mock.results[0]!.value;
    expect(vi.mocked(startCall).mock.calls[0]![0].requestContext).toBe(requestContext);
    expect(loadDeviceVoiceEnabled).toHaveBeenCalledWith(
      "riley",
      requestContext,
      expect.any(Function),
    );
    expect(rpc).toHaveBeenCalledWith("me", undefined, { requestContext });
    expect(rpc).toHaveBeenCalledWith("voice/status", { botId: "riley" }, { requestContext });
  });

  it("shares inferred readiness with the post-start transcription probe", async () => {
    vi.mocked(rpc)
      .mockClear()
      .mockImplementation(async (procedure) => {
        if (procedure === "voice/status") return { ready: false, transcribe: false } as never;
        throw new Error("Unauthorized");
      });
    vi.mocked(loadDeviceVoiceEnabled).mockImplementation(
      async (_botId, _context, readStatus) => !(await readStatus!()).ready,
    );
    render("riley");
    await act(async () => {
      await startVoiceCall?.();
    });
    expect(startCall).toHaveBeenCalledOnce();
    expect(
      vi.mocked(rpc).mock.calls.filter(([procedure]) => procedure === "voice/status"),
    ).toHaveLength(1);
  });

  describe.each(["Space", "session", "server"] as const)("%s switches during planning", (scope) => {
    it.each(["ready", "setup", "error"] as const)("drops a stale %s answer", async (answer) => {
      const status = deferred<{ ready: boolean; transcribe: boolean }>();
      const statusRequested = deferred<void>();
      vi.mocked(loadDeviceVoiceEnabled).mockResolvedValue(false);
      vi.mocked(rpc).mockImplementation(async (procedure) => {
        if (procedure === "voice/status") {
          statusRequested.resolve();
          return status.promise as never;
        }
        return { name: "Morgan" } as never;
      });
      render("riley");
      let pending: Promise<void> | undefined;
      await act(async () => {
        pending = startVoiceCall?.();
        await statusRequested.promise;
      });
      const requestContext = await vi.mocked(captureApiRequestContext).mock.results[0]!.value;
      expect(requestContext).toEqual({
        apiBase: "https://api.example.test",
        headers: { "x-rakazo-space-id": "space-riley" },
        sessionGeneration: currentSessionGeneration(),
      });
      expect(captureApiRequestContext).toHaveBeenCalledWith("space-riley");
      expect(rpc).toHaveBeenCalledWith("voice/status", { botId: "riley" }, { requestContext });
      expect(rpc).toHaveBeenCalledWith("me", undefined, { requestContext });
      expect(loadDeviceVoiceEnabled).toHaveBeenCalledWith(
        "riley",
        requestContext,
        expect.any(Function),
      );

      if (scope === "Space") {
        apiScope.spaceId = "space-max";
        apiScope.selectionGeneration += 1;
      } else if (scope === "server") {
        apiScope.apiBase = "https://other.example.test";
      } else {
        await saveSessionToken("fake-token-b");
      }
      await act(async () => {
        if (answer === "error") status.reject(new Error("Unavailable"));
        else status.resolve({ ready: answer === "ready", transcribe: true });
        await pending;
      });
      expect(captureApiRequestContext).toHaveBeenCalledOnce();
      expect(startCall).not.toHaveBeenCalled();
      expect(navigation.push).not.toHaveBeenCalled();
    });
  });

  it("starts fresh and put-through calls straight to listening with the greeting off", async () => {
    vi.mocked(loadCallGreetingEnabled).mockResolvedValue(false);
    vi.mocked(takeShortcutVoiceChat).mockReturnValueOnce(true);
    render("riley");
    await flush();
    openBotChat?.(max, true);
    render("max");
    await flush();

    expect(vi.mocked(startCall).mock.calls.map(([call]) => [call.botId, call.greeting])).toEqual([
      ["riley", undefined],
      ["max", undefined],
    ]);
  });

  it("keeps the greeting when the setting cannot be read", async () => {
    vi.mocked(loadCallGreetingEnabled).mockRejectedValue(new Error("device locked"));
    vi.mocked(takeShortcutVoiceChat).mockReturnValueOnce(true);
    render("riley");
    await flush();
    expect(startCall).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "riley", greeting: "Hello, Riley here." }),
    );
  });

  it("drops a hand-over queued before a sign-out", async () => {
    render("riley");
    openBotChat?.(max, true);
    await clearSessionToken();
    render("max");
    await flush();

    expect(startCall).not.toHaveBeenCalled();
  });
});

describe("read-aloud while a call is active", () => {
  let root: Root;
  let latestSpeakFrom: ReturnType<typeof useSpeakMessages>;

  const speakingBot = { id: "bot-b", name: "Bee", autoSpeak: true } as unknown as MobileBot;

  function activeCall(): CallState {
    return { botId: "bot-a", phase: "speaking" } as unknown as CallState;
  }

  function message(id: string, text: string): MobileMessage {
    return { id, role: "bot", blocks: [{ kind: "text", text }] } as unknown as MobileMessage;
  }

  function snapshot(messages: MobileMessage[], runStatus?: string): MobileSnapshot {
    return {
      botId: "bot-b",
      messages,
      run: runStatus ? { id: "run-1", status: runStatus } : null,
    } as unknown as MobileSnapshot;
  }

  function AutoSpeakHarness({ snap }: { snap: MobileSnapshot }) {
    useAutoSpeakReply({
      botId: speakingBot.id,
      inGroup: false,
      currentBot: speakingBot,
      snap,
      showingSaved: false,
    });
    return null;
  }

  function ManualReadHarness({ messages }: { messages: MobileMessage[] }) {
    latestSpeakFrom = useSpeakMessages({
      visibleMessages: messages,
      botId: speakingBot.id,
      members: undefined,
      displayName: speakingBot.name,
      mentionBots: [],
    });
    return null;
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(getCallSnapshot).mockReturnValue(null);
    vi.mocked(speakText).mockClear();
    vi.mocked(speakQueue).mockClear();
    vi.mocked(blockText).mockReturnValue("read from here");
    await saveSessionToken("fake-token-a");
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("does not auto-speak a finished reply while a call is active, and not once it ends", () => {
    vi.mocked(getCallSnapshot).mockReturnValue(activeCall());
    act(() =>
      root.render(
        createElement(AutoSpeakHarness, { snap: snapshot([message("m1", "first reply")]) }),
      ),
    );
    act(() =>
      root.render(
        createElement(AutoSpeakHarness, {
          snap: snapshot([message("m1", "first reply"), message("m2", "second reply")]),
        }),
      ),
    );
    expect(speakText).not.toHaveBeenCalled();

    vi.mocked(getCallSnapshot).mockReturnValue(null);
    act(() =>
      root.render(
        createElement(AutoSpeakHarness, {
          snap: snapshot([message("m1", "first reply"), message("m2", "second reply")]),
        }),
      ),
    );
    // The reply that finished during the call stays unspoken.
    expect(speakText).not.toHaveBeenCalled();

    act(() =>
      root.render(
        createElement(AutoSpeakHarness, {
          snap: snapshot([
            message("m1", "first reply"),
            message("m2", "second reply"),
            message("m3", "third reply"),
          ]),
        }),
      ),
    );
    expect(speakText).toHaveBeenCalledOnce();
    expect(speakText).toHaveBeenCalledWith(
      "third reply",
      expect.objectContaining({ botId: "bot-b" }),
    );
  });

  it("keeps a reply that streamed during a call silent when it completes after hang-up", () => {
    vi.mocked(getCallSnapshot).mockReturnValue(activeCall());
    act(() =>
      root.render(
        createElement(AutoSpeakHarness, { snap: snapshot([message("m1", "first reply")]) }),
      ),
    );
    act(() =>
      root.render(
        createElement(AutoSpeakHarness, {
          snap: snapshot([message("m1", "first reply"), message("m2", "second reply")], "running"),
        }),
      ),
    );
    expect(speakText).not.toHaveBeenCalled();

    vi.mocked(getCallSnapshot).mockReturnValue(null);
    act(() =>
      root.render(
        createElement(AutoSpeakHarness, {
          snap: snapshot([message("m1", "first reply"), message("m2", "second reply")]),
        }),
      ),
    );
    expect(speakText).not.toHaveBeenCalled();
  });

  it("auto-speaks a finished reply when no call is active", () => {
    act(() =>
      root.render(
        createElement(AutoSpeakHarness, { snap: snapshot([message("m1", "first reply")]) }),
      ),
    );
    act(() =>
      root.render(
        createElement(AutoSpeakHarness, {
          snap: snapshot([message("m1", "first reply"), message("m2", "second reply")]),
        }),
      ),
    );
    expect(speakText).toHaveBeenCalledOnce();
    expect(speakText).toHaveBeenCalledWith(
      "second reply",
      expect.objectContaining({ botId: "bot-b" }),
    );
  });

  it("does not start a manual read while a call is active", () => {
    vi.mocked(getCallSnapshot).mockReturnValue(activeCall());
    act(() =>
      root.render(createElement(ManualReadHarness, { messages: [message("m1", "first reply")] })),
    );
    act(() => latestSpeakFrom(message("m2", "second reply")));
    expect(speakQueue).not.toHaveBeenCalled();
  });

  it("reads from a message on request when no call is active", () => {
    act(() =>
      root.render(createElement(ManualReadHarness, { messages: [message("m1", "first reply")] })),
    );
    act(() => latestSpeakFrom(message("m2", "second reply")));
    expect(speakQueue).toHaveBeenCalledOnce();
    expect(vi.mocked(speakQueue).mock.calls[0]?.[0]?.[0]).toMatchObject({
      text: "read from here",
      botId: "bot-b",
      messageId: "m2",
    });
  });
});
