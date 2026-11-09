// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_TITLE_AVATAR_SIZE, ChatTitleAvatar } from "../components/chat-title-avatar";
import { CHAT_TITLE_HERO_AVATAR_SIZE, ChatTitleHero } from "../components/chat-title-hero";
import {
  ComputerFloatWindow,
  clampFloatPosition,
  clampFloatWidth,
  floatHeightForWidth,
} from "../components/thread/computer-float-window";
import { useThreadHeader } from "../components/thread/thread-header";
import { threadHeaderRight } from "../components/thread-header-right";
import {
  computerFloatEnabledFor,
  setComputerFloatEnabled,
  useComputerFloatEnabled,
} from "./computer-float-settings";
import { GROUP_SEAT_SIZE } from "./group-seats";
import { setFloatingBubbleModule, setSystemFloatWindowModule } from "./system-float";
import { isComputerRunning, useComputerRunning } from "./use-computer-running";

const rpc = vi.hoisted(() => vi.fn());
const activityStore = vi.hoisted(() => ({
  activity: "working",
  listeners: new Set<() => void>(),
  emit() {
    for (const listener of [...this.listeners]) listener();
  },
}));
const avatarState = vi.hoisted(() => ({
  props: undefined as { size?: number; status?: string; composing?: boolean } | undefined,
}));
const screens = vi.hoisted(() => ({
  source: "",
  onError: undefined as (() => void) | undefined,
  onHttpError: undefined as (() => void) | undefined,
  onLoad: undefined as (() => void) | undefined,
}));
const ios26 = vi.hoisted(() => ({ value: false }));
const panConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const animatedLoops = vi.hoisted(() => ({ started: 0, stopped: 0 }));
const reducedMotion = vi.hoisted(() => ({ value: false }));
const playbackBox = vi.hoisted(() => ({
  state: { status: "idle", botId: undefined as string | undefined, canPause: false },
  listeners: new Set<() => void>(),
  emit() {
    for (const listener of [...this.listeners]) listener();
  },
}));
const statusBox = vi.hoisted(() => ({
  current: undefined as unknown,
}));
const secureStoreBox = vi.hoisted(() => ({
  items: new Map<string, string>(),
  sets: [] as Array<[string, string]>,
}));
const platformBox = vi.hoisted(() => ({ os: "android" }));
const alertBox = vi.hoisted(() => ({ alert: vi.fn() }));
const appStateBox = vi.hoisted(() => ({
  listeners: new Set<(state: string) => void>(),
  emit(state: string) {
    for (const listener of [...this.listeners]) listener(state);
  },
}));
const bubbleBox = vi.hoisted(() => ({
  permitted: true,
  show: vi.fn(),
  hide: vi.fn(),
  requestOverlayPermission: vi.fn(),
}));
const windowBox = vi.hoisted(() => ({
  permitted: true,
  show: vi.fn(async (_url: string, _title: string, _locale: string) => true),
  updateUrl: vi.fn(async (_url: string) => undefined),
  hide: vi.fn(async () => undefined),
}));
const navBox = vi.hoisted(() => {
  const setOptions = vi.fn();
  const push = vi.fn();
  const setParams = vi.fn();
  return {
    setOptions,
    push,
    setParams,
    nav: { setOptions },
    router: { push, setParams },
  };
});

vi.mock("react-native", () => {
  function flatStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style);
    return (style ?? {}) as Record<string, unknown>;
  }
  function MockView(props: { children?: ReactNode; style?: unknown }) {
    const flat = flatStyle(props.style);
    const attrs: Record<string, unknown> = {};
    for (const key of ["left", "top", "width", "height"]) {
      if (typeof flat[key] === "number") attrs[`data-${key}`] = flat[key];
    }
    return createElement("div", attrs, props.children);
  }
  function MockText(props: { children?: ReactNode }) {
    return createElement("span", null, props.children);
  }
  function MockPressable(props: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) {
    return createElement(
      "button",
      {
        type: "button",
        role: props.accessibilityRole,
        "aria-label": props.accessibilityLabel,
        onClick: () => props.onPress?.(),
      },
      props.children,
    );
  }
  class MockAnimatedValue {
    _value: number;
    constructor(value: number) {
      this._value = value;
    }
    setValue(value: number) {
      this._value = value;
    }
  }
  type Anim = { start: (callback?: () => void) => void; stop: () => void };
  const timing = (value: MockAnimatedValue, config: { toValue: number }): Anim => ({
    start: (callback?: () => void) => {
      value.setValue(config.toValue);
      callback?.();
    },
    stop: () => undefined,
  });
  const sequence = (anims: Anim[]): Anim => ({
    start: (callback?: () => void) => {
      anims.forEach((anim) => {
        anim.start();
      });
      callback?.();
    },
    stop: () => {
      anims.forEach((anim) => {
        anim.stop();
      });
    },
  });
  const loop = (anim: Anim): Anim => ({
    start: (callback?: () => void) => {
      animatedLoops.started += 1;
      anim.start(callback);
    },
    stop: () => {
      animatedLoops.stopped += 1;
      anim.stop();
    },
  });
  return {
    ActivityIndicator: () => createElement("progress"),
    Alert: { alert: alertBox.alert },
    AppState: {
      addEventListener: (_type: string, handler: (state: string) => void) => {
        appStateBox.listeners.add(handler);
        return { remove: () => appStateBox.listeners.delete(handler) };
      },
    },
    Platform: {
      get OS() {
        return platformBox.os;
      },
    },
    Animated: {
      Value: MockAnimatedValue,
      View: (props: { children?: ReactNode }) =>
        createElement("div", { "data-animated": true }, props.children),
      loop,
      sequence,
      timing,
    },
    PanResponder: {
      create: (config: Record<string, unknown>) => {
        panConfigs.push(config);
        return { panHandlers: {} };
      },
    },
    Pressable: MockPressable,
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: MockText,
    View: MockView,
    useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
  };
});

vi.mock("react-native-reanimated", () => ({
  default: {
    Text: (props: { children?: ReactNode }) => createElement("span", null, props.children),
  },
  FadeIn: { duration: (ms: number) => ({ kind: "fade-in", ms }) },
  FadeOut: { duration: (ms: number) => ({ kind: "fade-out", ms }) },
  useReducedMotion: () => reducedMotion.value,
}));

vi.mock("./voice", () => ({
  getVoicePlaybackState: () => playbackBox.state,
  subscribeVoicePlayback: (listener: () => void) => {
    playbackBox.listeners.add(listener);
    return () => playbackBox.listeners.delete(listener);
  },
}));

vi.mock("react-native-webview", () => ({
  WebView: (props: {
    source?: { uri: string };
    onError?: () => void;
    onHttpError?: () => void;
    onLoad?: () => void;
  }) => {
    screens.source = props.source?.uri ?? "";
    screens.onError = props.onError;
    screens.onHttpError = props.onHttpError;
    screens.onLoad = props.onLoad;
    return createElement("iframe", { title: "screen" });
  },
}));

vi.mock("./api", () => ({ currentApiBase: () => "https://api.example.test", rpc }));
vi.mock("react-native-android-floating-bubble", () => {
  throw new Error("no native module in tests");
});
// No window module in this build: the pop-out falls back to the bubble,
// and the window tests inject their module through the seam instead.
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));

vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key);
  return { t, useI18n: () => ({ t, locale: "en" }) };
});

vi.mock("./appearance", () => ({
  mobileTokens: () => ({
    background: "background",
    border: "border",
    card: "card",
    foreground: "foreground",
    mutedForeground: "muted-foreground",
    primary: "primary",
    secondary: "secondary",
    success: "success",
  }),
}));

vi.mock("./native", () => ({
  useThemedStyles: <T,>(factory: () => T) => factory(),
  useResolvedAppearance: () => "light",
}));
vi.mock("./native-controls", () => ({
  HEADER_CONTROL_SIZE: 44,
  HEADER_TITLE_MAX_FONT_SCALE: 2,
  iosAtLeast: () => ios26.value,
}));
vi.mock("./color", () => ({ transparentColor: (color: string) => color }));

vi.mock("../components/native-symbol", () => ({
  NativeSymbol: (props: { ios: string; android: string; size?: number; color?: string }) =>
    createElement("span", {
      "data-symbol-ios": props.ios,
      "data-symbol-android": props.android,
      "data-size": props.size,
      "data-color": props.color,
    }),
}));

vi.mock("../lib/expression-avatar", () => ({ useExpressionPack: () => "chief" }));
vi.mock("../components/bot-avatar", () => ({
  BotAvatar: () => createElement("span", { "data-avatar": "plain" }),
}));
vi.mock("../components/bot-state-avatar", () => ({
  BotStateAvatar: (props: { size?: number; status?: string; composing?: boolean }) => {
    avatarState.props = props;
    return createElement("span", { "data-avatar": "state" });
  },
}));
vi.mock("../lib/logo-avatar-activity", () => ({
  mobileLogoAvatarActivity: {
    subscribe: (listener: () => void) => {
      activityStore.listeners.add(listener);
      return () => activityStore.listeners.delete(listener);
    },
    getActivity: () => activityStore.activity,
  },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => secureStoreBox.items.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secureStoreBox.sets.push([key, value]);
    secureStoreBox.items.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secureStoreBox.items.delete(key);
  },
}));

vi.mock("../components/chat-header-title", () => ({
  publishChatTitle: vi.fn(() => () => undefined),
}));
vi.mock("../components/sheet-header", () => ({ trailingHeaderOptions: () => ({}) }));
vi.mock("./thread-edges", () => ({ threadEdgeOptions: () => ({}) }));
vi.mock("./archived-chats", () => ({ notifyArchivedChatsChanged: () => undefined }));
vi.mock("./bot-lifecycle", () => ({ restoreArchivedBot: async () => undefined }));
vi.mock("./chat-settings-route", () => ({ chatTitleRoute: () => undefined }));
vi.mock("./conversation-cleared", () => ({ onConversationCleared: () => () => undefined }));
vi.mock("./referral", () => ({ useReferral: () => null }));
vi.mock("./user-error", () => ({ errorText: (cause: unknown) => String(cause) }));

vi.mock("expo-router", () => ({
  router: navBox.router,
  useNavigation: () => navBox.nav,
  useRoute: () => ({ key: "route-1" }),
  useRouter: () => navBox.router,
}));

const runningStatus: ComputerStatus = {
  botId: "bot-1",
  mode: "team",
  kind: "docker",
  state: "running",
  controlHolder: "none",
  controlBotId: null,
  takeoverRequested: false,
  screenAvailable: true,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: null,
  busyBotName: "Chief",
  canUpdate: false,
  terminalAvailable: false,
};
const stoppedStatus: ComputerStatus = { ...runningStatus, state: "stopped" };

function respond(status: ComputerStatus, screenUrl: string | null) {
  rpc.mockImplementation(async (method: string) => {
    if (method === "computer/status") return status;
    if (method === "computer/screenUrl") return { url: screenUrl };
    return {};
  });
}

function respondLive(screenUrl: string | null) {
  rpc.mockImplementation(async (method: string) => {
    if (method === "computer/status") return statusBox.current;
    if (method === "computer/screenUrl") return { url: screenUrl };
    return {};
  });
}

function calls(method: string) {
  return rpc.mock.calls.filter(([called]) => called === method);
}

describe("computer float window", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    rpc.mockReset();
    activityStore.activity = "working";
    activityStore.listeners.clear();
    avatarState.props = undefined;
    screens.source = "";
    screens.onError = undefined;
    screens.onHttpError = undefined;
    screens.onLoad = undefined;
    ios26.value = false;
    panConfigs.length = 0;
    animatedLoops.started = 0;
    animatedLoops.stopped = 0;
    reducedMotion.value = false;
    playbackBox.state = { status: "idle", botId: undefined, canPause: false };
    playbackBox.listeners.clear();
    statusBox.current = runningStatus;
    navBox.setOptions.mockClear();
    navBox.push.mockClear();
    navBox.setParams.mockClear();
    platformBox.os = "android";
    alertBox.alert.mockClear();
    appStateBox.listeners.clear();
    bubbleBox.permitted = true;
    bubbleBox.show.mockClear();
    bubbleBox.hide.mockClear();
    bubbleBox.requestOverlayPermission.mockClear();
    windowBox.permitted = true;
    windowBox.show.mockClear();
    windowBox.updateUrl.mockClear();
    windowBox.hide.mockClear();
    setFloatingBubbleModule({
      isSupported: () => true,
      hasOverlayPermission: () => bubbleBox.permitted,
      requestOverlayPermission: () => bubbleBox.requestOverlayPermission(),
      show: () => bubbleBox.show(),
      hide: () => bubbleBox.hide(),
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = undefined;
    container = undefined;
    setFloatingBubbleModule(null);
    setSystemFloatWindowModule(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function settle() {
    await act(async () => {
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    });
  }

  function render(element: ReactNode) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(element);
    });
    return container;
  }

  function renderFloat(props: { botId?: string; open: boolean; onClose?: () => void }) {
    return render(
      <ComputerFloatWindow
        botId={props.botId ?? "bot-1"}
        name="Chief"
        open={props.open}
        onClose={props.onClose ?? (() => undefined)}
      />,
    );
  }

  function injectWindowModule() {
    setSystemFloatWindowModule({
      isSupported: async () => true,
      hasOverlayPermission: async () => windowBox.permitted,
      requestOverlayPermission: () => undefined,
      show: (url: string, title: string, locale: string) => windowBox.show(url, title, locale),
      updateUrl: (url: string) => windowBox.updateUrl(url),
      hide: () => windowBox.hide(),
      isShowing: async () => false,
    });
  }

  it("sizes the title avatar to the mockup's 34pt and leaves group seats at 28", () => {
    expect(CHAT_TITLE_AVATAR_SIZE).toBe(34);
    expect(GROUP_SEAT_SIZE).toBe(28);
    expect(CHAT_TITLE_AVATAR_SIZE).toBeGreaterThan(GROUP_SEAT_SIZE);
  });

  it("passes the 34pt size and the untouched status through to the state avatar", () => {
    const bot = {
      id: "bot-1",
      name: "Chief",
      color: "#123456",
      avatarSet: "chief",
      notifyOnFinish: true,
    } as never;
    render(<ChatTitleAvatar bot={bot} status="working" composing />);
    expect(avatarState.props).toMatchObject({ size: 34, status: "working", composing: true });
  });

  it("sizes the chat hero avatar to 88pt, above the 80pt floor", () => {
    expect(CHAT_TITLE_HERO_AVATAR_SIZE).toBe(88);
    expect(CHAT_TITLE_HERO_AVATAR_SIZE).toBeGreaterThanOrEqual(80);
    expect(CHAT_TITLE_HERO_AVATAR_SIZE).toBeGreaterThan(CHAT_TITLE_AVATAR_SIZE);
  });

  it("passes an explicit size through to the state avatar", () => {
    const bot = {
      id: "bot-1",
      name: "Chief",
      color: "#123456",
      avatarSet: "chief",
      notifyOnFinish: true,
    } as never;
    render(<ChatTitleAvatar bot={bot} status="working" composing={false} size={88} />);
    expect(avatarState.props).toMatchObject({ size: 88, status: "working", composing: false });
  });

  it("renders the hero with the big avatar, the name and the live activity", () => {
    const bot = {
      id: "bot-1",
      name: "Chief",
      color: "#123456",
      avatarSet: "chief",
      notifyOnFinish: true,
    } as never;
    const rendered = render(
      <ChatTitleHero
        bot={bot}
        status="working"
        composing={false}
        name="Chief"
        activityLine="Thinking…"
      />,
    );
    expect(avatarState.props).toMatchObject({ size: 88 });
    expect(rendered.textContent).toContain("Chief");
    expect(rendered.textContent).toContain("Thinking…");
  });

  it("shows the done badge only once a run finishes, with the done face", () => {
    const bot = {
      id: "bot-1",
      name: "Chief",
      color: "#123456",
      avatarSet: "chief",
      notifyOnFinish: true,
    } as never;
    const element = <ChatTitleAvatar bot={bot} status="working" composing={false} />;
    const rendered = render(element);
    expect(rendered.querySelector('[data-symbol-ios="checkmark"]')).toBeNull();
    activityStore.activity = "idle";
    act(() => {
      activityStore.emit();
    });
    expect(rendered.querySelector('[data-symbol-ios="checkmark"]')).not.toBeNull();
  });

  it("shows the live screen while the computer runs and hides it when closed", async () => {
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    expect(opened.querySelector('iframe[title="screen"]')).not.toBeNull();
    expect(screens.source).toBe("https://screen.example.test/embed");
    act(() => {
      root?.render(
        <ComputerFloatWindow botId="bot-1" name="Chief" open={false} onClose={() => undefined} />,
      );
    });
    expect(opened.querySelector('iframe[title="screen"]')).toBeNull();
    expect(opened.textContent).toBe("");
  });

  it("shows only the status text when the screen fails to load, without throwing", async () => {
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    expect(opened.querySelector('iframe[title="screen"]')).not.toBeNull();
    act(() => {
      screens.onError?.();
    });
    expect(opened.querySelector('iframe[title="screen"]')).toBeNull();
    expect(opened.textContent).toContain("Team Computer");
  });

  it("shows the status text when there is no screen URL", async () => {
    respond(runningStatus, null);
    const opened = renderFloat({ open: true });
    await settle();
    expect(opened.querySelector('iframe[title="screen"]')).toBeNull();
    expect(opened.textContent).toContain("Team Computer");
  });

  it("shows the stopped status when the computer is not running", async () => {
    respond(stoppedStatus, null);
    const opened = renderFloat({ open: true });
    await settle();
    expect(opened.textContent).toContain("Computer is stopped");
  });

  it("closes from its Close button", async () => {
    respond(runningStatus, "https://screen.example.test/embed");
    const onClose = vi.fn();
    const opened = renderFloat({ open: true, onClose });
    await settle();
    const close = opened.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    expect(close).not.toBeNull();
    act(() => {
      close.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the pop-out button on Android and hides it on iOS", async () => {
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    expect(opened.querySelector('button[aria-label="Float outside the app"]')).not.toBeNull();
    platformBox.os = "ios";
    act(() => {
      root?.render(
        <ComputerFloatWindow botId="bot-1" name="Chief" open onClose={() => undefined} />,
      );
    });
    expect(opened.querySelector('button[aria-label="Float outside the app"]')).toBeNull();
  });

  it("floats the bubble from the pop-out button and stops it from the same button", async () => {
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    const popOut = opened.querySelector(
      'button[aria-label="Float outside the app"]',
    ) as HTMLButtonElement;
    act(() => {
      popOut.click();
    });
    await settle();
    expect(bubbleBox.show).toHaveBeenCalledTimes(1);
    // The in-app float stays open as the fallback: the bubble only shows
    // once the app is in the background.
    expect(opened.querySelector('iframe[title="screen"]')).not.toBeNull();
    const stop = opened.querySelector(
      'button[aria-label="Stop floating outside the app"]',
    ) as HTMLButtonElement;
    expect(stop).not.toBeNull();
    expect(stop.querySelector('span[data-color="primary"]')).not.toBeNull();
    act(() => {
      stop.click();
    });
    await settle();
    expect(bubbleBox.hide).toHaveBeenCalledTimes(1);
    expect(opened.querySelector('button[aria-label="Float outside the app"]')).not.toBeNull();
  });

  it("asks for the overlay permission when it is missing, then floats once granted", async () => {
    bubbleBox.permitted = false;
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    const popOut = opened.querySelector(
      'button[aria-label="Float outside the app"]',
    ) as HTMLButtonElement;
    act(() => {
      popOut.click();
    });
    await settle();
    expect(bubbleBox.show).not.toHaveBeenCalled();
    expect(alertBox.alert).toHaveBeenCalledWith(
      "Allow floating over other apps",
      expect.stringContaining("Display over other apps"),
      expect.any(Array),
    );
    // The in-app float stays up: it is the fallback while permission is missing.
    expect(opened.querySelector('iframe[title="screen"]')).not.toBeNull();
    // Grant it in Settings and come back to the app.
    bubbleBox.permitted = true;
    const buttons = alertBox.alert.mock.calls[0]![2] as Array<{
      text: string;
      onPress?: () => void;
    }>;
    act(() => {
      buttons.find((button) => button.text === "Open Settings")?.onPress?.();
    });
    await settle();
    expect(bubbleBox.requestOverlayPermission).toHaveBeenCalledTimes(1);
    act(() => {
      appStateBox.emit("active");
    });
    await settle();
    expect(bubbleBox.show).toHaveBeenCalledTimes(1);
  });

  it("hides the bubble when the float closes", async () => {
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    const popOut = opened.querySelector(
      'button[aria-label="Float outside the app"]',
    ) as HTMLButtonElement;
    act(() => {
      popOut.click();
    });
    await settle();
    expect(bubbleBox.show).toHaveBeenCalledTimes(1);
    act(() => {
      root?.render(
        <ComputerFloatWindow botId="bot-1" name="Chief" open={false} onClose={() => undefined} />,
      );
    });
    await settle();
    expect(bubbleBox.hide).toHaveBeenCalledTimes(1);
  });

  it("floats the live screen in a system window from the pop-out button", async () => {
    injectWindowModule();
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    const popOut = opened.querySelector(
      'button[aria-label="Float outside the app"]',
    ) as HTMLButtonElement;
    act(() => {
      popOut.click();
    });
    await settle();
    expect(windowBox.show).toHaveBeenCalledTimes(1);
    expect(windowBox.show).toHaveBeenCalledWith(
      "https://screen.example.test/embed",
      "Computer screen",
      "en",
    );
    // The bubble stays down: the window carries the live screen itself.
    expect(bubbleBox.show).not.toHaveBeenCalled();
    // The in-app float stays open as the fallback.
    expect(opened.querySelector('iframe[title="screen"]')).not.toBeNull();
    const stop = opened.querySelector(
      'button[aria-label="Stop floating outside the app"]',
    ) as HTMLButtonElement;
    expect(stop).not.toBeNull();
    act(() => {
      stop.click();
    });
    await settle();
    expect(windowBox.hide).toHaveBeenCalledTimes(1);
    expect(opened.querySelector('button[aria-label="Float outside the app"]')).not.toBeNull();
  });

  it("asks for the overlay permission when it is missing, then floats the window once granted", async () => {
    injectWindowModule();
    windowBox.permitted = false;
    bubbleBox.permitted = false;
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    const popOut = opened.querySelector(
      'button[aria-label="Float outside the app"]',
    ) as HTMLButtonElement;
    act(() => {
      popOut.click();
    });
    await settle();
    expect(windowBox.show).not.toHaveBeenCalled();
    expect(alertBox.alert).toHaveBeenCalledWith(
      "Allow floating over other apps",
      expect.stringContaining("computer screen floats over other apps"),
      expect.any(Array),
    );
    // The in-app float stays up: it is the fallback while permission is missing.
    expect(opened.querySelector('iframe[title="screen"]')).not.toBeNull();
    // Grant it in Settings and come back to the app.
    windowBox.permitted = true;
    bubbleBox.permitted = true;
    const buttons = alertBox.alert.mock.calls[0]![2] as Array<{
      text: string;
      onPress?: () => void;
    }>;
    act(() => {
      buttons.find((button) => button.text === "Open Settings")?.onPress?.();
    });
    await settle();
    expect(bubbleBox.requestOverlayPermission).toHaveBeenCalledTimes(1);
    act(() => {
      appStateBox.emit("active");
    });
    await settle();
    expect(windowBox.show).toHaveBeenCalledTimes(1);
    expect(bubbleBox.show).not.toHaveBeenCalled();
  });

  it("hides the system window when the float closes", async () => {
    injectWindowModule();
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    const popOut = opened.querySelector(
      'button[aria-label="Float outside the app"]',
    ) as HTMLButtonElement;
    act(() => {
      popOut.click();
    });
    await settle();
    expect(windowBox.show).toHaveBeenCalledTimes(1);
    act(() => {
      root?.render(
        <ComputerFloatWindow botId="bot-1" name="Chief" open={false} onClose={() => undefined} />,
      );
    });
    await settle();
    expect(windowBox.hide).toHaveBeenCalledTimes(1);
  });

  it("re-points the system window when the screen URL rotates", async () => {
    vi.useFakeTimers();
    injectWindowModule();
    respondLive("https://screen.example.test/embed-1");
    const opened = renderFloat({ open: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const popOut = opened.querySelector(
      'button[aria-label="Float outside the app"]',
    ) as HTMLButtonElement;
    act(() => {
      popOut.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(windowBox.show).toHaveBeenCalledWith(
      "https://screen.example.test/embed-1",
      "Computer screen",
      "en",
    );
    // A new status shape re-reads the screen URL; the window follows it.
    statusBox.current = { ...runningStatus, homeRevision: "rev-2" };
    respondLive("https://screen.example.test/embed-2");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(windowBox.updateUrl).toHaveBeenCalledWith("https://screen.example.test/embed-2");
  });

  it("stops polling once the float is closed", async () => {
    vi.useFakeTimers();
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const polled = calls("computer/status").length;
    expect(polled).toBeGreaterThan(0);
    // Close first, in its own act, so the dispose has run before time advances: a render
    // awaited inside the same async act as the timer advance would still be open for it.
    act(() => {
      root?.render(
        <ComputerFloatWindow botId="bot-1" name="Chief" open={false} onClose={() => undefined} />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls("computer/status").length).toBe(polled);
    expect(opened.querySelector('iframe[title="screen"]')).toBeNull();
  });

  it("keeps a dragged float inside the window", () => {
    expect(clampFloatPosition(-50, -20, 393, 852, 300, 224)).toEqual({ x: 16, y: 16 });
    expect(clampFloatPosition(500, 900, 393, 852, 300, 224)).toEqual({ x: 77, y: 612 });
    expect(clampFloatPosition(40, 120, 393, 852, 300, 224)).toEqual({ x: 40, y: 120 });
  });

  it("clamps the float width between 160 and 90% of the screen", () => {
    expect(clampFloatWidth(100, 393, 852)).toBe(160);
    expect(clampFloatWidth(300, 393, 852)).toBe(300);
    expect(clampFloatWidth(500, 393, 852)).toBeCloseTo(393 * 0.9, 0);
    expect(clampFloatWidth(600, 1000, 400)).toBeCloseTo((400 * 0.9 - 36) * 1.6, 0);
    expect(floatHeightForWidth(160)).toBe(136);
    expect(floatHeightForWidth(300)).toBe(224);
  });

  type PanHandlers = {
    onPanResponderGrant?: () => void;
    onPanResponderMove?: (_event: unknown, gesture: { dx: number; dy: number }) => void;
  };

  function floatBox(opened: HTMLDivElement, width: number) {
    return opened.querySelector(`div[data-width="${width}"]`) as HTMLDivElement | null;
  }

  function floatGeometry(opened: HTMLDivElement) {
    const box = opened.querySelector("div[data-width][data-left]") as HTMLDivElement | null;
    return box
      ? {
          left: Number(box.dataset.left),
          top: Number(box.dataset.top),
          width: Number(box.dataset.width),
          height: Number(box.dataset.height),
        }
      : null;
  }

  it("grows from the corner grip and keeps the frame 16:10", async () => {
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    expect(floatGeometry(opened)).toMatchObject({ left: 77, top: 120, width: 300, height: 224 });
    const resize = panConfigs[1] as PanHandlers;
    act(() => {
      resize.onPanResponderGrant?.();
    });
    act(() => {
      resize.onPanResponderMove?.(null, { dx: 40, dy: 25 });
    });
    // A diagonal drag takes its dominant axis: max(40, 25 × 1.6) = 40 wider.
    expect(floatGeometry(opened)).toMatchObject({ width: 340, height: 249 });
    // Docked at the right edge, it grows left instead of leaving the screen.
    expect(floatGeometry(opened)).toMatchObject({ left: 37 });
    expect(floatBox(opened, 340)).not.toBeNull();
  });

  it("shrinks from the corner grip but never below 160 wide", async () => {
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    const resize = panConfigs[1] as PanHandlers;
    act(() => {
      resize.onPanResponderGrant?.();
    });
    act(() => {
      resize.onPanResponderMove?.(null, { dx: -200, dy: -100 });
    });
    expect(floatGeometry(opened)).toMatchObject({ width: 160, height: 136 });
  });

  it("keeps moving and resizing on separate gestures", async () => {
    respond(runningStatus, "https://screen.example.test/embed");
    const opened = renderFloat({ open: true });
    await settle();
    const move = panConfigs[0] as PanHandlers;
    const resize = panConfigs[1] as PanHandlers;
    act(() => {
      move.onPanResponderGrant?.();
    });
    act(() => {
      // Left, not right: the float rests docked at the right edge, so a rightward drag clamps.
      move.onPanResponderMove?.(null, { dx: -20, dy: 10 });
    });
    expect(floatGeometry(opened)).toMatchObject({ left: 57, top: 130, width: 300 });
    act(() => {
      resize.onPanResponderGrant?.();
    });
    act(() => {
      resize.onPanResponderMove?.(null, { dx: -50, dy: -30 });
    });
    expect(floatGeometry(opened)).toMatchObject({ left: 57, top: 130, width: 252 });
  });

  it("closes itself when the run ends while it is open", async () => {
    vi.useFakeTimers();
    respondLive("https://screen.example.test/embed");
    const onClose = vi.fn();
    renderFloat({ open: true, onClose });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onClose).not.toHaveBeenCalled();
    statusBox.current = stoppedStatus;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never reopens after a manual close, even when the run ends", async () => {
    vi.useFakeTimers();
    respondLive("https://screen.example.test/embed");
    const onClose = vi.fn();
    const opened = renderFloat({ open: true, onClose });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const close = opened.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    act(() => {
      close.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      root?.render(
        <ComputerFloatWindow botId="bot-1" name="Chief" open={false} onClose={onClose} />,
      );
    });
    statusBox.current = stoppedStatus;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(opened.querySelector('iframe[title="screen"]')).toBeNull();
  });

  it("stays open when the run already ended before it opened", async () => {
    statusBox.current = stoppedStatus;
    respondLive(null);
    const onClose = vi.fn();
    const opened = renderFloat({ open: true, onClose });
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(opened.textContent).toContain("Computer is stopped");
  });

  it("treats only a running computer as running", () => {
    expect(isComputerRunning(runningStatus)).toBe(true);
    expect(isComputerRunning(stoppedStatus)).toBe(false);
    expect(isComputerRunning(null)).toBe(false);
    expect(isComputerRunning(undefined)).toBe(false);
  });

  it("hides the header entry while the computer is stopped", async () => {
    respond(stoppedStatus, null);
    const onOpen = vi.fn();
    const options = threadHeaderRight({
      inGroup: false,
      readOnly: false,
      t: (text: string) => text,
      color: "foreground",
      onGroupSettings: () => undefined,
      onInvite: undefined,
      computerRunning: false,
      onOpenComputerFloat: onOpen,
    });
    const rendered = render(createElement("div", null, options.headerRight?.({})));
    expect(rendered.querySelector('button[aria-label="Computer screen"]')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows the header entry while the computer runs and opens the float", () => {
    const onOpen = vi.fn();
    const options = threadHeaderRight({
      inGroup: false,
      readOnly: false,
      t: (text: string) => text,
      color: "foreground",
      onGroupSettings: () => undefined,
      onInvite: undefined,
      computerRunning: true,
      onOpenComputerFloat: onOpen,
    });
    const rendered = render(createElement("div", null, options.headerRight?.({})));
    const entry = rendered.querySelector(
      'button[aria-label="Computer screen"]',
    ) as HTMLButtonElement;
    expect(entry).not.toBeNull();
    act(() => {
      entry.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("lists the float entry among the iOS 26 header items while the computer runs", () => {
    ios26.value = true;
    const options = threadHeaderRight({
      inGroup: false,
      readOnly: false,
      t: (text: string) => text,
      color: "foreground",
      onGroupSettings: () => undefined,
      onInvite: undefined,
      computerRunning: true,
      onOpenComputerFloat: () => undefined,
    });
    const items = options.unstable_headerRightItems?.({}) ?? [];
    expect(items.some((item) => item.type === "button" && item.label === "Computer screen")).toBe(
      true,
    );
  });

  it("reports the computer as running from its status", async () => {
    respond(runningStatus, null);
    function Probe({ botId }: { botId: string | undefined }) {
      const [seen, setSeen] = useState<boolean | null>(null);
      const running = useComputerRunning(botId);
      useEffect(() => {
        setSeen(running);
      }, [running]);
      return createElement("span", null, seen === null ? "pending" : String(seen));
    }
    const rendered = render(<Probe botId="bot-1" />);
    await settle();
    expect(rendered.textContent).toBe("true");
  });

  function renderAutoSpeakButton(botId: string | undefined) {
    const options = threadHeaderRight({
      botId,
      inGroup: false,
      readOnly: false,
      t: (text: string) => text,
      color: "foreground",
      onGroupSettings: () => undefined,
      onInvite: undefined,
      autoSpeak: true,
      onToggleAutoSpeak: () => undefined,
    });
    return render(createElement("div", null, options.headerRight?.({})));
  }

  it("pulses the speaker while this bot's reply is being read aloud", () => {
    playbackBox.state = { status: "playing", botId: "bot-1", canPause: true };
    const rendered = renderAutoSpeakButton("bot-1");
    expect(animatedLoops.started).toBe(1);
    expect(rendered.querySelector("div[data-animated]")).not.toBeNull();
  });

  it("leaves the speaker static when nothing is being read aloud", () => {
    playbackBox.state = { status: "idle", botId: undefined, canPause: false };
    renderAutoSpeakButton("bot-1");
    expect(animatedLoops.started).toBe(0);
  });

  it("leaves the speaker static while another bot is speaking", () => {
    playbackBox.state = { status: "playing", botId: "bot-2", canPause: true };
    renderAutoSpeakButton("bot-1");
    expect(animatedLoops.started).toBe(0);
  });

  it("leaves the speaker static with reduced motion, even while reading aloud", () => {
    reducedMotion.value = true;
    playbackBox.state = { status: "playing", botId: "bot-1", canPause: true };
    renderAutoSpeakButton("bot-1");
    expect(animatedLoops.started).toBe(0);
  });

  it("stops the pulse when the reading finishes", () => {
    playbackBox.state = { status: "playing", botId: "bot-1", canPause: true };
    const rendered = renderAutoSpeakButton("bot-1");
    expect(animatedLoops.started).toBe(1);
    playbackBox.state = { status: "idle", botId: undefined, canPause: false };
    act(() => {
      playbackBox.emit();
    });
    expect(animatedLoops.stopped).toBe(1);
    expect(rendered.querySelector("div[data-animated]")).not.toBeNull();
  });

  describe("computer float setting", () => {
    it("is on by default for a bot that never set it", async () => {
      let seen: boolean | undefined;
      function Probe() {
        seen = useComputerFloatEnabled("bot-default");
        return null;
      }
      render(<Probe />);
      await settle();
      expect(seen).toBe(true);
      expect(computerFloatEnabledFor("bot-default")).toBe(true);
      expect(computerFloatEnabledFor(undefined)).toBe(true);
    });

    it("reflects the switch live through the hook", async () => {
      let seen: boolean | undefined;
      function Probe() {
        seen = useComputerFloatEnabled("bot-live");
        return null;
      }
      render(<Probe />);
      await settle();
      expect(seen).toBe(true);
      act(() => {
        setComputerFloatEnabled("bot-live", false);
      });
      expect(seen).toBe(false);
      act(() => {
        setComputerFloatEnabled("bot-live", true);
      });
      expect(seen).toBe(true);
    });

    it("persists the switched-off choice for the next launch", async () => {
      setComputerFloatEnabled("bot-persist", false);
      await settle();
      const written = [...secureStoreBox.sets]
        .reverse()
        .find(([key]) => key === "rakazo.computer-float-enabled");
      expect(written).toBeDefined();
      expect(JSON.parse(written?.[1] ?? "{}")).toMatchObject({ "bot-persist": false });
      expect(secureStoreBox.items.get("rakazo.computer-float-enabled")).toBe(written?.[1]);
    });
  });

  describe("header respects the float switch", () => {
    function renderHeader(props: { enabled: boolean; opener: boolean }) {
      function Header() {
        useThreadHeader({
          botId: "bot-1",
          inGroup: false,
          readOnly: false,
          displayName: "Chief",
          composingBots: "",
          onCleared: () => undefined,
          computerFloatEnabled: props.enabled,
          onOpenComputerFloat: props.opener ? () => undefined : undefined,
        });
        return null;
      }
      return render(<Header />);
    }

    function headerEntry() {
      const options = navBox.setOptions.mock.calls.at(-1)?.[0] as
        | { headerRight?: (props: Record<string, unknown>) => ReactNode }
        | undefined;
      const headerRight = options?.headerRight;
      if (!headerRight) return null;
      const probe = document.createElement("div");
      document.body.append(probe);
      const probeRoot = createRoot(probe);
      act(() => {
        probeRoot.render(createElement("div", null, headerRight({})));
      });
      const found = probe.querySelector('button[aria-label="Computer screen"]');
      act(() => {
        probeRoot.unmount();
      });
      probe.remove();
      return found;
    }

    it("hides the entry when the opener is gone, even while the computer runs", () => {
      const options = threadHeaderRight({
        inGroup: false,
        readOnly: false,
        t: (text: string) => text,
        color: "foreground",
        onGroupSettings: () => undefined,
        onInvite: undefined,
        computerRunning: true,
        onOpenComputerFloat: undefined,
      });
      const rendered = render(createElement("div", null, options.headerRight?.({})));
      expect(rendered.querySelector('button[aria-label="Computer screen"]')).toBeNull();
    });

    it("hides the entry and never polls status while the switch is off", async () => {
      respond(runningStatus, null);
      renderHeader({ enabled: false, opener: false });
      await settle();
      expect(calls("computer/status")).toHaveLength(0);
      expect(headerEntry()).toBeNull();
    });

    it("shows the entry again while the switch is on and the computer runs", async () => {
      respond(runningStatus, null);
      renderHeader({ enabled: true, opener: true });
      await settle();
      expect(calls("computer/status").length).toBeGreaterThan(0);
      expect(headerEntry()).not.toBeNull();
    });
  });
});
