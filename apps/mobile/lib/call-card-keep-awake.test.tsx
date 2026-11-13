// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallCard } from "../components/CallCard";
import { rpc } from "./api";
import type { CallDeps } from "./call-session";
import { endCall, startCall, toggleTranscript, useCallActive } from "./call-session";
import { hapticImpact } from "./haptics";

vi.mock("./haptics", () => ({
  hapticImpact: vi.fn(),
  hapticSelection: vi.fn(),
  hapticSuccess: vi.fn(),
}));

const { activeTags, platform, sessionChange, startBackground, stopBackground, useKeepAwake } =
  vi.hoisted(() => ({
    activeTags: new Set<string>(),
    platform: { OS: "android", Version: 35 },
    sessionChange: {
      generation: 0,
      listeners: new Set<() => void>(),
      /** Emulates a sign-in or sign-out: a new generation notifies every observer. */
      fire() {
        this.generation += 1;
        for (const listener of this.listeners) listener();
      },
    },
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
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
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
vi.mock("../components/glass-icon-button", () => ({
  GlassIconButton: ({
    accessibilityLabel,
    onPress,
  }: {
    accessibilityLabel: string;
    onPress: () => void;
  }) =>
    createElement("button", { type: "button", "aria-label": accessibilityLabel, onClick: onPress }),
}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api", () => ({
  rpc: vi.fn().mockResolvedValue({ name: "Test" }),
  applyMobileThreadEvent: vi.fn(),
  captureApiRequestContext: vi.fn(),
}));
vi.mock("./mobile-types", () => ({
  blockText: vi.fn(),
}));
vi.mock("./api-server", () => ({
  configureSessionEndHangUp: vi.fn(),
}));
vi.mock("./api-live", () => ({
  subscribeThread: vi.fn(),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => sessionChange.generation,
  subscribeSessionGeneration: (listener: () => void) => {
    sessionChange.listeners.add(listener);
    return () => sessionChange.listeners.delete(listener);
  },
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("expo-file-system", () => ({ File: class {} }));
const idlePlayback = vi.hoisted(() => ({ status: "idle" }));
vi.mock("./voice", () => ({
  subscribeVoicePlayback: () => () => undefined,
  getVoicePlaybackState: () => idlePlayback,
  createSpeechOwner: () => Symbol("SpeechOwner"),
  speakText: vi.fn(),
  stopSpeaking: vi.fn(),
  setCallAudio: vi.fn(async () => undefined),
  setDictationAudio: vi.fn(async () => undefined),
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
  answer: vi.fn(),
  followUp: vi.fn(),
  endCall: async () => undefined,
  speak: async () => undefined,
  watch: () => vi.fn(),
  stopSpeaking: vi.fn(),
  audio: async () => undefined,
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
    sessionChange.generation = 0;
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

  it("only rerenders call-presence subscribers when a call starts or ends", async () => {
    const render = vi.fn();
    function CallPresence() {
      const active = useCallActive();
      render(active);
      return null;
    }
    act(() => root.render(<CallPresence />));
    expect(render).toHaveBeenLastCalledWith(false);
    await act(async () => {
      startCall({ botId: "bot-1", botName: "Ada" }, deps);
    });
    expect(render).toHaveBeenLastCalledWith(true);
    render.mockClear();
    act(() => toggleTranscript());
    expect(render).not.toHaveBeenCalled();
    act(() => endCall());
    expect(render).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("uses explicit hang-up feedback only when the Hang up button is pressed", async () => {
    act(() => root.render(<CallCard />));
    await act(async () => {
      startCall({ botId: "bot-1", botName: "Ada" }, deps);
    });
    vi.mocked(hapticImpact).mockClear();
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Hang up"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(hapticImpact).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Hang up"]')).toBeNull();
    await act(async () => endCall());
    expect(hapticImpact).toHaveBeenCalledOnce();
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

  it("shows the signed-in account's initial after a session change", async () => {
    const me = vi.mocked(rpc);
    me.mockResolvedValueOnce({ name: "Alicja" } as never);
    me.mockClear();
    // The card stays mounted in the app layout; earlier tests left another session's initial.
    act(() => root.render(<CallCard />));
    act(() => sessionChange.fire());

    await act(async () => {
      startCall({ botId: "bot-1", botName: "Rex" }, deps);
    });
    await vi.waitFor(() => expect(container.textContent).toContain("A"));
    expect(me).toHaveBeenCalledWith("me");
    expect(me).toHaveBeenCalledTimes(1);

    await act(async () => endCall());
    // A different account signs in without an app restart; the card stays mounted.
    me.mockResolvedValueOnce({ name: "Bartek" } as never);
    act(() => sessionChange.fire());

    await act(async () => {
      startCall({ botId: "bot-2", botName: "Nova" }, deps);
    });
    await vi.waitFor(() => expect(container.textContent).toContain("B"));
    expect(me).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("A");
  });
});
