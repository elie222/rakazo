// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallCard } from "../components/CallCard";
import type { CallDeps } from "./call-session";
import { endCall, startCall } from "./call-session";

const { activeTags, useKeepAwake } = vi.hoisted(() => ({
  activeTags: new Set<string>(),
  useKeepAwake: vi.fn(),
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
    Platform: { OS: "ios", Version: 18 },
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
vi.mock("./voice", () => ({ speakText: vi.fn(), stopSpeaking: vi.fn() }));
vi.mock("./dictation", () => ({ available: vi.fn(), listen: vi.fn() }));

describe("CallCard keep-awake lifetime", () => {
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
    useKeepAwake.mockReset();
    vi.unstubAllGlobals();
  });

  it("keeps the screen awake only while a call is active", async () => {
    const deps: CallDeps = {
      dictate: async () => true,
      record: vi.fn(),
      transcribe: vi.fn(),
      send: vi.fn(),
      endCall: async () => undefined,
      speak: async () => undefined,
      watch: () => vi.fn(),
      stopSpeaking: vi.fn(),
    };

    act(() => root.render(<CallCard />));
    expect(container.childElementCount).toBe(0);
    expect(useKeepAwake).not.toHaveBeenCalled();
    expect(activeTags.has("rakazo-call")).toBe(false);

    await act(async () => {
      startCall({ botId: "bot-1", botName: "Ada" }, deps);
    });
    expect(container.textContent).toContain("Ada");
    expect(useKeepAwake).toHaveBeenCalledWith("rakazo-call");
    expect(activeTags.has("rakazo-call")).toBe(true);

    await act(async () => endCall());
    expect(container.childElementCount).toBe(0);
    expect(activeTags.has("rakazo-call")).toBe(false);
  });
});
