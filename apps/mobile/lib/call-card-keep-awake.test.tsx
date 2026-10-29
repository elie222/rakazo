// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallCard } from "../components/CallCard";
import type { CallDeps } from "./call-session";
import { endCall, startCall } from "./call-session";

const { activeTags, platform, startBackground, stopBackground, useKeepAwake } = vi.hoisted(() => ({
  activeTags: new Set<string>(),
  platform: { OS: "android", Version: 35 },
  startBackground: vi.fn(async () => false),
  stopBackground: vi.fn(async () => undefined),
  useKeepAwake: vi.fn(),
}));

vi.mock("./call-background", () => ({
  startCallBackground: startBackground,
  stopCallBackground: stopBackground,
}));
vi.mock("expo-audio", () => ({
  AudioModule: { getRecordingPermissionsAsync: async () => ({ granted: true }) },
}));
vi.mock("expo-keep-awake", () => ({ useKeepAwake }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("react-native-reanimated", () => ({ useReducedMotion: () => true }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("react-native", () => {
  function View({ children }: { children?: ReactNode }) {
    return createElement("div", null, children);
  }
  return {
    View,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    Pressable: (props: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
    }) =>
      createElement(
        "button",
        { type: "button", onClick: props.onPress, "aria-label": props.accessibilityLabel },
        props.children,
      ),
    Animated: {
      View,
      Value: class {
        setValue = vi.fn();
      },
      loop: () => ({ start: vi.fn(), stop: vi.fn() }),
      sequence: vi.fn(),
      timing: vi.fn(),
      delay: vi.fn(),
    },
    Platform: platform,
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  };
});
vi.mock("../components/glass-icon-button", () => ({ GlassIconButton: () => null }));
vi.mock("./api", () => ({
  rpc: vi.fn().mockResolvedValue({ name: "Test" }),
  applyMobileThreadEvent: vi.fn(),
  blockText: vi.fn(),
  captureApiRequestContext: vi.fn(),
  subscribeThread: vi.fn(),
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({ t: (text: string) => text }),
  t: (text: string) => text,
  getActiveUiLocale: () => "en",
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("./voice", () => ({
  createSpeechOwner: () => Symbol("SpeechOwner"),
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
  setVoiceBackgroundPlayback: vi.fn(),
}));
vi.mock("./dictation", () => ({ available: vi.fn(), listen: vi.fn() }));
vi.mock("./call-sounds", () => ({
  playCallCue: vi.fn(),
  preloadWaitSound: vi.fn(),
  releaseWaitSound: vi.fn(),
  startWaitSound: vi.fn(),
  stopWaitSound: vi.fn(),
}));

const deps: CallDeps = {
  dictate: async () => true,
  record: vi.fn(),
  transcribe: vi.fn(),
  send: vi.fn(),
  endCall: async () => undefined,
  speak: async () => undefined,
  watch: () => vi.fn(),
  stopSpeaking: vi.fn(),
  cue: async () => undefined,
  waitSound: vi.fn(),
};

describe("CallCard background lifetime", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useKeepAwake.mockImplementation((tag: string) => {
      useEffect(() => {
        activeTags.add(tag);
        return () => {
          activeTags.delete(tag);
        };
      }, [tag]);
    });
    activeTags.clear();
    platform.OS = "android";
    startBackground.mockReset();
    startBackground.mockResolvedValue(false);
    stopBackground.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      endCall();
      root.unmount();
    });
    container.remove();
    activeTags.clear();
    vi.unstubAllGlobals();
  });

  it("keeps the screen awake while the native service has not started", async () => {
    act(() => root.render(<CallCard />));
    expect(activeTags.size).toBe(0);

    await act(async () => {
      startCall({ botId: "bot-1", botName: "Ada" }, deps);
      await Promise.resolve();
    });

    expect(startBackground).toHaveBeenCalledWith("Ada");
    expect(activeTags.has("rakazo-call")).toBe(true);
  });

  it("releases the screen awake hold once the native service starts", async () => {
    startBackground.mockResolvedValue(true);
    act(() => root.render(<CallCard />));

    await act(async () => {
      startCall({ botId: "bot-1", botName: "Ada" }, deps);
      await Promise.resolve();
    });

    expect(startBackground).toHaveBeenCalledWith("Ada");
    expect(activeTags.has("rakazo-call")).toBe(false);

    await act(async () => endCall());
    expect(stopBackground).toHaveBeenCalled();
  });

  it("keeps the screen awake on iOS without the Android call service", async () => {
    platform.OS = "ios";
    act(() => root.render(<CallCard />));

    await act(async () => {
      startCall({ botId: "bot-1", botName: "Ada" }, deps);
      await Promise.resolve();
    });

    expect(startBackground).not.toHaveBeenCalled();
    expect(activeTags.has("rakazo-call")).toBe(true);
  });
});
