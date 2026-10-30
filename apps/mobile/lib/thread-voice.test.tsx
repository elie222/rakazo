// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileBot } from "./api";
import { startCall } from "./call-session";
import { clearSessionToken, currentSessionGeneration, saveSessionToken } from "./session";
import { useThreadVoiceCall } from "./thread-voice";

vi.mock("expo-router", () => ({
  useNavigation: () => ({ isFocused: () => true }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: { currentState: "active" },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("./live-notifications", () => ({ stopLiveNotifications: vi.fn(async () => undefined) }));
vi.mock("./thread-feedback", () => ({ clearFailedSends: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
// Signed out, every request fails; device voice needs none of them to start the microphone.
vi.mock("./api", () => ({
  blockText: vi.fn(),
  rpc: vi.fn(async () => {
    throw new Error("Unauthorized");
  }),
}));
vi.mock("./call-session", () => ({
  setCallProviderTranscribe: vi.fn(),
  startCall: vi.fn(() => "call-1"),
}));
vi.mock("./device-voice", () => ({ loadDeviceVoiceEnabled: async () => true }));
vi.mock("./dictation", () => ({ available: async () => true }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./voice", () => ({ speakQueue: vi.fn(), speakText: vi.fn() }));

const riley = { id: "riley", name: "Riley" } as MobileBot;
const max = { id: "max", name: "Max" } as MobileBot;
const bots = [riley, max];

describe("useThreadVoiceCall hand-over", () => {
  let root: Root;
  let openBotChat: ((target: MobileBot, ring: boolean) => void) | undefined;

  function render(botId: string) {
    function Thread() {
      openBotChat = useThreadVoiceCall({
        botId,
        readOnly: false,
        displayName: bots.find((bot) => bot.id === botId)?.name,
        mentionBots: bots,
        mentionBotsRef: { current: bots },
        activeBotId: { current: botId },
      }).openBotChat;
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

  it("drops a hand-over queued before a sign-out", async () => {
    render("riley");
    openBotChat?.(max, true);
    await clearSessionToken();
    render("max");
    await flush();

    expect(startCall).not.toHaveBeenCalled();
  });
});
