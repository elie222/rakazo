// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "../api/api";
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

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("expo-router", () => ({
  useNavigation: () => ({ isFocused: () => true }),
  useRouter: () => router,
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
  captureApiRequestContext: vi.fn(async () => ({
    apiBase: "https://api.example.test",
    headers: { "x-rakazo-space-id": "space-riley" },
    sessionGeneration: currentSessionGeneration(),
  })),
  rpc: vi.fn(async () => {
    throw new Error("Unauthorized");
  }),
  selectedSpaceId: () => "space-riley",
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
    router.push.mockClear();
    vi.mocked(Alert.alert).mockClear();
    vi.mocked(takeShortcutVoiceChat).mockReset().mockReturnValue(false);
    vi.mocked(loadCallGreetingEnabled).mockReset().mockResolvedValue(true);
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
  });

  it("shows why a call could not start instead of opening Voice settings", async () => {
    vi.mocked(loadDeviceVoiceEnabled).mockResolvedValueOnce(false);
    render("riley");
    await act(async () => {
      await startVoiceCall?.();
    });
    expect(startCall).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith("Could not start the call", "Unauthorized");
  });

  it("opens the Space's own Voice settings when the Space overrides voice", async () => {
    vi.mocked(loadDeviceVoiceEnabled).mockResolvedValueOnce(false);
    vi.mocked(rpc).mockImplementation((async (proc: string) => {
      if (proc === "voice/status") return { ready: false, transcribe: false };
      if (proc === "spaceSettings/overrides") return ["voice"];
      throw new Error("Unauthorized");
    }) as typeof rpc);
    render("riley");
    await act(async () => {
      await startVoiceCall?.();
    });
    vi.mocked(rpc).mockReset().mockRejectedValue(new Error("Unauthorized"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/voice",
      params: { spaceId: "space-riley" },
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
      text: "second reply",
      botId: "bot-b",
      messageId: "m2",
    });
  });

  it("manual read speaks the reply text and skips a steps block", () => {
    const reply = {
      id: "m2",
      role: "bot",
      blocks: [
        { kind: "steps", steps: [{ label: "Web search", count: 2 }] },
        { kind: "text", text: "Here is the answer." },
      ],
    } as unknown as MobileMessage;
    act(() => root.render(createElement(ManualReadHarness, { messages: [reply] })));
    act(() => latestSpeakFrom(reply));
    expect(speakQueue).toHaveBeenCalledOnce();
    expect(vi.mocked(speakQueue).mock.calls[0]?.[0]?.[0]).toMatchObject({
      text: "Here is the answer.",
      botId: "bot-b",
      messageId: "m2",
    });
  });
});
