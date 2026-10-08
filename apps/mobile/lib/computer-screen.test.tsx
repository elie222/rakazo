// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, Fragment } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Computer from "../app/computer";

const rpc = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => {
  function MockView(props: { children?: ReactNode }) {
    return createElement("div", null, props.children);
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

  function MockModal(props: { children?: ReactNode; visible?: boolean }) {
    return props.visible ? createElement("section", null, props.children) : null;
  }

  return {
    Modal: MockModal,
    Pressable: MockPressable,
    ScrollView: MockView,
    Text: MockView,
    View: MockView,
  };
});

vi.mock("react-native-webview", () => {
  return {
    WebView: (props: {
      accessibilityElementsHidden?: boolean;
      importantForAccessibility?: string;
    }) =>
      createElement("iframe", {
        title: "screen",
        "data-elements-hidden": String(Boolean(props.accessibilityElementsHidden)),
        "data-important": props.importantForAccessibility ?? "auto",
      }),
  };
});

vi.mock("react-native-safe-area-context", () => {
  const Passthrough = (props: { children?: ReactNode }) =>
    createElement(Fragment, null, props.children);
  return {
    initialWindowMetrics: null,
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
  };
});

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ botId: "bot-1", name: "Basil" }),
  useNavigation: () => ({ setOptions: () => undefined }),
}));

vi.mock("expo-screen-orientation", () => ({
  OrientationLock: { DEFAULT: 0, PORTRAIT_UP: 1 },
  lockAsync: () => Promise.resolve(),
}));

vi.mock("../components/native-action-button", () => {
  return {
    NativeActionButton: (props: { label: string; onPress: () => void; prominence?: string }) =>
      createElement(
        "button",
        { type: "button", "data-prominence": props.prominence, onClick: props.onPress },
        props.label,
      ),
  };
});

vi.mock("../components/glass-icon-button", () => {
  return {
    GlassIconButton: (props: { accessibilityLabel: string; onPress: () => void }) =>
      createElement("button", {
        type: "button",
        "aria-label": props.accessibilityLabel,
        onClick: props.onPress,
      }),
  };
});

vi.mock("../components/computer-maintenance-actions", () => ({
  ComputerMaintenanceActions: () => null,
}));

vi.mock("../components/computer-mode-picker", () => ({ ComputerModePicker: () => null }));

vi.mock("./api", () => ({ currentApiBase: () => "https://api.example.test", rpc }));

vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key);
  return { t, useI18n: () => ({ t }) };
});

vi.mock("./native", () => ({
  useMobileTokens: () => ({
    background: "background",
    border: "border",
    card: "card",
    foreground: "foreground",
    muted: "muted",
    mutedForeground: "muted-foreground",
    primary: "primary",
    success: "success",
  }),
}));

vi.mock("./native-controls", () => ({ iosAtLeast: () => false }));

const botWorking: ComputerStatus = {
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
  busyBotName: "Basil",
  canUpdate: false,
  terminalAvailable: false,
};

function respond(status: ComputerStatus) {
  rpc.mockImplementation(async (method: string) => {
    if (method === "computer/status") return status;
    if (method === "computer/screenUrl") return { url: "https://screen.example.test/embed" };
    return {};
  });
}

function calls(method: string) {
  return rpc.mock.calls.filter(([called]) => called === method);
}

describe("computer screen", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    rpc.mockReset();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
  });

  async function settle() {
    await act(async () => {
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    });
  }

  async function render() {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(<Computer />);
    });
    await settle();
    return container;
  }

  function preview(view: HTMLElement) {
    const element = view.querySelector<HTMLElement>('[aria-label="Open computer"]');
    if (!element) throw new Error("missing preview");
    return element;
  }

  function takeControlButtons(view: HTMLElement) {
    return Array.from(view.querySelectorAll("button")).filter(
      (button) => button.textContent === "Take control",
    );
  }

  it("opens the full window from the preview without taking control from the bot", async () => {
    respond(botWorking);
    const view = await render();
    expect(view.querySelector("section")).toBeNull();

    await act(async () => preview(view).click());
    await settle();

    const fullWindow = view.querySelector("section");
    expect(fullWindow?.querySelector('[aria-label="Close computer"]')).not.toBeNull();
    expect(calls("computer/takeover")).toEqual([]);
    const screens = view.querySelectorAll("iframe");
    expect(screens).toHaveLength(1);
    expect(fullWindow?.contains(screens[0] ?? null)).toBe(true);
    expect(screens[0]?.getAttribute("data-elements-hidden")).toBe("true");
    expect(screens[0]?.getAttribute("data-important")).toBe("no-hide-descendants");
    const buttons = takeControlButtons(view);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.dataset.prominence).toBe("secondary");

    const headerTakeControl = buttons.find((button) => fullWindow?.contains(button));
    expect(headerTakeControl).toBeDefined();
    respond({ ...botWorking, controlHolder: "user", controlBotId: "bot-1", busyBotName: null });
    await act(async () => headerTakeControl?.click());
    await settle();

    expect(calls("computer/takeover")).toEqual([["computer/takeover", { botId: "bot-1" }]]);
    expect(fullWindow?.querySelector("iframe")?.getAttribute("data-elements-hidden")).toBe("false");
    expect(fullWindow?.querySelector("iframe")?.getAttribute("data-important")).toBe("auto");
  });

  it("wakes a sleeping computer from the preview without taking control", async () => {
    respond({ ...botWorking, state: "suspended", busyBotName: null });
    const view = await render();
    expect(calls("computer/boot")).toEqual([]);

    await act(async () => preview(view).click());
    await settle();

    expect(calls("computer/boot")).toHaveLength(1);
    expect(calls("computer/takeover")).toEqual([]);
  });

  it("takes control only from the Take control button", async () => {
    respond(botWorking);
    const view = await render();

    await act(async () => takeControlButtons(view)[0]?.click());
    await settle();

    expect(calls("computer/takeover")).toEqual([["computer/takeover", { botId: "bot-1" }]]);
  });

  it("names the preview as a button", async () => {
    respond(botWorking);
    const view = await render();

    expect(preview(view).getAttribute("role")).toBe("button");
  });

  it("keeps the view-only screen out of the accessibility tree", async () => {
    respond(botWorking);
    const view = await render();

    const screen = view.querySelector("iframe");
    expect(screen?.getAttribute("data-elements-hidden")).toBe("true");
    expect(screen?.getAttribute("data-important")).toBe("no-hide-descendants");
  });

  it("keeps the screen accessible in the full window while the user has control", async () => {
    respond({ ...botWorking, controlHolder: "user", controlBotId: "bot-1", busyBotName: null });
    const view = await render();

    await act(async () => preview(view).click());
    await settle();

    const screens = view.querySelectorAll("iframe");
    expect(screens).toHaveLength(1);
    expect(screens[0]?.getAttribute("data-elements-hidden")).toBe("false");
    expect(screens[0]?.getAttribute("data-important")).toBe("auto");
  });
});
