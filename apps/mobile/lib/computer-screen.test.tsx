// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, Fragment, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Computer from "../app/computer";

const rpc = vi.hoisted(() => vi.fn());
const textScale = vi.hoisted(() => ({ fontScale: 1 }));
const appState = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
const foreground = vi.hoisted(() => ({ value: true }));
const screens = vi.hoisted(() => ({ mounts: 0 }));
const picker = vi.hoisted(() => ({
  mounts: 0,
  props: undefined as
    | { value?: string; disabled?: boolean; onChange: (mode: string) => void }
    | undefined,
}));

vi.mock("react-native", () => {
  function MockView(props: {
    children?: ReactNode;
    style?: { flexDirection?: string; flex?: number; alignSelf?: string; color?: string };
  }) {
    return createElement(
      "div",
      {
        "data-color": props.style?.color,
        "data-direction": props.style?.flexDirection,
        "data-flex": props.style?.flex,
        "data-align-self": props.style?.alignSelf,
      },
      props.children,
    );
  }

  function MockPressable(props: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { busy?: boolean };
    disabled?: boolean;
  }) {
    return createElement(
      "button",
      {
        type: "button",
        role: props.accessibilityRole,
        "aria-label": props.accessibilityLabel,
        "aria-busy": props.accessibilityState?.busy,
        disabled: props.disabled,
        onClick: () => props.onPress?.(),
      },
      props.children,
    );
  }

  function MockModal(props: { children?: ReactNode; visible?: boolean }) {
    return props.visible ? createElement("section", null, props.children) : null;
  }

  return {
    ActivityIndicator: (props: { size?: string }) =>
      createElement("progress", { "data-size": props.size }),
    AppState: {
      addEventListener: (_type: string, listener: (state: string) => void) => {
        appState.listeners.add(listener);
        return { remove: () => appState.listeners.delete(listener) };
      },
    },
    Modal: MockModal,
    Pressable: MockPressable,
    ScrollView: MockView,
    Text: MockView,
    View: MockView,
    useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, ...textScale }),
  };
});

vi.mock("./app-foreground", () => ({
  useAppForeground: () => foreground.value,
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
}));
vi.mock("../components/computer-keyboard-bar", () => ({
  ComputerKeyboardBar: () => createElement("div", { "data-keyboard-bar": true }),
}));

vi.mock("react-native-webview", () => {
  return {
    WebView: (props: {
      accessibilityElementsHidden?: boolean;
      importantForAccessibility?: string;
    }) => {
      useEffect(() => {
        screens.mounts += 1;
      }, []);
      return createElement("iframe", {
        title: "screen",
        "data-elements-hidden": String(Boolean(props.accessibilityElementsHidden)),
        "data-important": props.importantForAccessibility ?? "auto",
      });
    },
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

vi.mock("../lib/orientation", () => ({
  holdFreeRotation: () => () => undefined,
}));

vi.mock("../components/native-action-button", () => {
  return {
    NativeActionButton: (props: {
      label: string;
      onPress: () => void;
      prominence?: string;
      size?: string;
      disabled?: boolean;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          "data-prominence": props.prominence,
          "data-size": props.size,
          disabled: props.disabled,
          onClick: props.onPress,
        },
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

vi.mock("../components/computer-mode-picker", () => {
  return {
    ComputerModePicker: (props: {
      value?: string;
      disabled?: boolean;
      onChange: (mode: string) => void;
    }) => {
      picker.props = props;
      useEffect(() => {
        picker.mounts += 1;
      }, []);
      return null;
    },
  };
});

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
    destructive: "destructive",
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
    textScale.fontScale = 1;
    picker.mounts = 0;
    picker.props = undefined;
    appState.listeners.clear();
    foreground.value = true;
    screens.mounts = 0;
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
    const element = view.querySelector<HTMLButtonElement>('[aria-label="Open computer"]');
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
    expect(view.querySelector("[data-keyboard-bar]")).toBeNull();
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
    expect(fullWindow?.querySelector("[data-keyboard-bar]")).not.toBeNull();
  });

  it("wakes a sleeping computer from the preview without taking control", async () => {
    respond({ ...botWorking, state: "suspended", busyBotName: null });
    const view = await render();
    expect(calls("computer/boot")).toEqual([]);

    await act(async () => preview(view).click());
    await settle();

    expect(calls("computer/boot")).toHaveLength(1);
    expect(calls("computer/takeover")).toEqual([]);
    expect(view.querySelector("[data-keyboard-bar]")).toBeNull();
  });

  it("takes control only from the Take control button", async () => {
    respond(botWorking);
    const view = await render();

    await act(async () => takeControlButtons(view)[0]?.click());
    await settle();

    expect(calls("computer/takeover")).toEqual([["computer/takeover", { botId: "bot-1" }]]);
  });

  function statusLabel(view: HTMLElement) {
    const label = Array.from(view.querySelectorAll("div")).find(
      (element) => element.textContent === "Basil is using it" && !element.querySelector("div"),
    );
    if (!label) throw new Error("missing status label");
    return label;
  }

  it("keeps the status beside Take control at standard text sizes", async () => {
    respond(botWorking);
    const view = await render();

    expect(statusLabel(view).parentElement?.dataset.direction).toBe("row");
    expect(statusLabel(view).dataset.flex).toBe("1");
    expect(statusLabel(view).dataset.alignSelf).toBeUndefined();
  });

  it("puts Take control under the status once text reaches its largest size", async () => {
    // Text stops growing at xxxLarge but the native button doesn't: at AX5 it took the row and
    // the label wrapped one letter per line.
    textScale.fontScale = 1.353;
    respond(botWorking);
    const view = await render();

    const row = statusLabel(view).parentElement;
    expect(row?.dataset.direction).toBe("column");
    expect(statusLabel(view).dataset.flex).toBeUndefined();
    expect(statusLabel(view).dataset.alignSelf).toBe("stretch");
    expect(row?.lastElementChild?.textContent).toBe("Take control");
  });

  it("remounts the mode picker when the status row restacks, without side effects", async () => {
    respond(botWorking);
    const pendingSwitch = new Promise(() => undefined);
    const status = rpc.getMockImplementation()!;
    rpc.mockImplementation((method: string, ...rest: unknown[]) =>
      method === "bots/setComputer" ? pendingSwitch : status(method, ...rest),
    );
    const view = await render();
    expect(picker.mounts).toBe(1);

    await act(async () => picker.props?.onChange("dedicated"));
    await settle();
    expect(picker.props).toMatchObject({ value: "team", disabled: true });
    const callsBefore = rpc.mock.calls.length;

    // The native picker keeps a stale height when the row above restacks.
    textScale.fontScale = 1.353;
    act(() => {
      root?.render(<Computer />);
    });
    await settle();

    expect(statusLabel(view).parentElement?.dataset.direction).toBe("column");
    expect(picker.mounts).toBe(2);
    expect(picker.props).toMatchObject({ value: "team", disabled: true });
    expect(rpc.mock.calls.length).toBe(callsBefore);
    expect(calls("bots/setComputer")).toHaveLength(1);
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

  async function setForeground(value: boolean) {
    foreground.value = value;
    act(() => root?.render(<Computer />));
    await settle();
  }

  it.each([false, true])(
    "unmounts the screen in the background and mounts fresh on return (full window: %s)",
    async (fullWindow) => {
      respond(botWorking);
      const view = await render();
      if (fullWindow) {
        await act(async () => preview(view).click());
        await settle();
      }
      expect(view.querySelectorAll("iframe")).toHaveLength(1);
      const mounted = screens.mounts;

      await setForeground(false);
      expect(view.querySelector("iframe")).toBeNull();
      expect(screens.mounts).toBe(mounted);

      await setForeground(true);
      expect(view.querySelectorAll("iframe")).toHaveLength(1);
      expect(screens.mounts).toBe(mounted + 1);
      expect(Boolean(view.querySelector("section iframe"))).toBe(fullWindow);
    },
  );

  it("stops heartbeats in the background and resumes them on return", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      respond(botWorking);
      await render();
      expect(calls("computer/heartbeat")).toHaveLength(1);
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(calls("computer/heartbeat")).toHaveLength(2);

      await setForeground(false);
      await act(async () => vi.advanceTimersByTime(120_000));
      expect(calls("computer/heartbeat")).toHaveLength(2);

      await setForeground(true);
      expect(calls("computer/heartbeat")).toHaveLength(3);
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(calls("computer/heartbeat")).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
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

  it("loads the screen again when the app returns from the background", async () => {
    respond({ ...botWorking, controlHolder: "user", controlBotId: "bot-1", busyBotName: null });
    const view = await render();
    await act(async () => preview(view).click());
    await settle();
    const opened = screens.mounts;

    const emit = async (state: string) => {
      await act(async () => {
        for (const listener of appState.listeners) listener(state);
      });
      await settle();
    };
    await emit("inactive");
    await emit("active");
    expect(screens.mounts).toBe(opened);

    await emit("background");
    await emit("active");
    expect(screens.mounts).toBe(opened + 1);
    expect(view.querySelector("section iframe")?.getAttribute("data-elements-hidden")).toBe(
      "false",
    );
  });
  describe("while the computer boots", () => {
    const stopped: ComputerStatus = { ...botWorking, state: "stopped", busyBotName: null };
    const idle: ComputerStatus = { ...botWorking, busyBotName: null };
    let status: ComputerStatus;
    let boots: { resolve: () => void; reject: (error: Error) => void }[];

    beforeEach(() => {
      boots = [];
      status = stopped;
      rpc.mockImplementation(async (method: string) => {
        if (method === "computer/status") return status;
        if (method === "computer/screenUrl")
          return { url: status.state === "running" ? "https://screen.example.test/embed" : null };
        if (method === "computer/boot")
          return new Promise<void>((resolve, reject) => boots.push({ resolve, reject }));
        return {};
      });
    });

    function previewButton(view: HTMLElement) {
      const element = view.querySelector<HTMLButtonElement>('button[role="button"]');
      if (!element) throw new Error("missing preview");
      return element;
    }

    function tryAgain(view: HTMLElement) {
      return Array.from(view.querySelectorAll("button")).find(
        (button) => button.textContent === "Try again",
      );
    }

    async function finishBoot(next: ComputerStatus) {
      status = next;
      await act(async () => boots.at(-1)?.resolve());
      await settle();
    }

    it("shows the boot in the preview, without covering Back, and blocks a second start", async () => {
      const view = await render();

      expect(calls("computer/boot")).toHaveLength(1);
      expect(view.querySelector("section")).toBeNull();
      expect(view.querySelector("progress")?.getAttribute("data-size")).toBe("large");
      expect(view.textContent).toContain("Booting live desktop…");
      expect(previewButton(view).disabled).toBe(true);
      expect(previewButton(view).getAttribute("aria-label")).toBe("Booting live desktop…");
      expect(previewButton(view).getAttribute("aria-busy")).toBe("true");
      expect(takeControlButtons(view)[0]?.disabled).toBe(true);
      expect(picker.props?.disabled).toBe(true);

      await finishBoot(idle);

      expect(view.querySelector("section")).toBeNull();
      expect(view.querySelector("progress")).toBeNull();
      expect(view.querySelector("iframe")).not.toBeNull();
      expect(preview(view).disabled).toBe(false);
      expect(takeControlButtons(view)[0]?.disabled).toBe(false);
      expect(picker.props?.disabled).toBe(false);
    });

    it("opens the full window once a tapped boot finishes", async () => {
      status = { ...stopped, state: "suspended" };
      const view = await render();
      expect(calls("computer/boot")).toEqual([]);

      await act(async () => preview(view).click());
      await settle();
      expect(view.querySelector("section")).toBeNull();
      expect(view.querySelector("progress")).not.toBeNull();

      await finishBoot(idle);

      expect(view.querySelector("section")).not.toBeNull();
      expect(calls("computer/takeover")).toEqual([]);
    });

    it("leaves the boot to finish on the server when the screen closes", async () => {
      await render();
      expect(calls("computer/boot")).toHaveLength(1);
      act(() => root?.unmount());
      root = undefined;
      const callsBefore = rpc.mock.calls.length;

      status = idle;
      await act(async () => boots[0]?.resolve());
      await settle();

      expect(rpc.mock.calls.length).toBe(callsBefore);
    });

    it.each([
      new Error("Internal server error"),
      Object.assign(new Error("Service failed"), { status: 500 }),
      new Error("HTTP 503 Service unavailable"),
      new Error("Network request failed"),
      new Error("Request timed out"),
    ])("shows friendly recovery for %s", async (error) => {
      const view = await render();
      await act(async () => boots[0]?.reject(error));
      await settle();

      const title = Array.from(view.querySelectorAll("[data-color]")).find(
        (element) => element.textContent === "Couldn't start the computer",
      );
      expect(title?.getAttribute("data-color")).toBe("destructive");
      expect(view.textContent).toContain(
        "Something went wrong while it was starting. Try again in a moment.",
      );
      expect(view.textContent).not.toContain(error.message);
      expect(tryAgain(view)?.getAttribute("data-prominence")).toBe("primary");
      expect(tryAgain(view)?.getAttribute("data-size")).toBe("default");
      expect(tryAgain(view)?.disabled).toBe(false);
    });

    it.each([
      new Error("Network request failed"),
      Object.assign(new Error("Service failed"), { status: 500 }),
    ])("explains retry after a running computer's reconnect fails: %s", async (error) => {
      status = idle;
      const view = await render();
      expect(calls("computer/boot")).toHaveLength(1);
      await act(async () => boots[0]?.reject(error));
      await settle();

      expect(view.textContent).not.toContain("Couldn't start the computer");
      expect(view.textContent).toContain(
        "Something went wrong while it was starting. Try again in a moment.",
      );
      expect(tryAgain(view)?.disabled).toBe(false);
    });

    it("offers Try again after a failed boot", async () => {
      const view = await render();
      expect(tryAgain(view)).toBeUndefined();

      await act(async () => boots[0]?.reject(new Error("Computer is busy")));
      await settle();

      expect(view.textContent).toContain("Computer is busy");
      expect(view.querySelector("progress")).toBeNull();
      expect(preview(view).disabled).toBe(false);
      expect(tryAgain(view)).toBeDefined();

      await act(async () => tryAgain(view)?.click());
      await settle();
      expect(calls("computer/boot")).toHaveLength(2);
      expect(tryAgain(view)).toBeUndefined();
      expect(view.textContent).not.toContain("Computer is busy");
      expect(view.querySelector("progress")).not.toBeNull();

      await finishBoot(idle);
      expect(view.textContent).not.toContain("Computer is busy");
      expect(view.querySelector("iframe")).not.toBeNull();
    });

    it("keeps a failed boot's error and Try again through later status checks", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const view = await render();
        await act(async () => boots[0]?.reject(new Error("Computer is busy")));
        await settle();

        // The next poll reads a stopped computer with no screen and no error of its own.
        await act(async () => vi.advanceTimersByTime(2000));
        await settle();
        expect(calls("computer/screenUrl").length).toBeGreaterThan(0);
        expect(view.textContent).toContain("Computer is busy");
        expect(tryAgain(view)).toBeDefined();

        status = { ...stopped, state: "error" };
        await act(async () => vi.advanceTimersByTime(2000));
        await settle();
        expect(view.textContent).toContain("Computer failed to boot");
        expect(tryAgain(view)).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops Try again once a later status shows the computer running", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const view = await render();
        await act(async () => boots[0]?.reject(new Error("Computer is busy")));
        await settle();
        expect(tryAgain(view)).toBeDefined();

        // Another client started it.
        status = idle;
        await act(async () => vi.advanceTimersByTime(2000));
        await settle();
        expect(view.querySelector("iframe")).not.toBeNull();
        expect(tryAgain(view)).toBeUndefined();
        expect(calls("computer/boot")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports a takeover that times out on a running computer", async () => {
      status = idle;
      const base = rpc.getMockImplementation()!;
      rpc.mockImplementation((method: string, ...rest: unknown[]) =>
        method === "computer/takeover"
          ? Promise.reject(
              Object.defineProperty(new Error("Request timed out"), "name", {
                value: "TimeoutError",
              }),
            )
          : base(method, ...rest),
      );
      const view = await render();
      await act(async () => boots[0]?.resolve());
      await settle();
      expect(view.querySelector("iframe")).not.toBeNull();
      const bootsBefore = calls("computer/boot").length;

      await act(async () => takeControlButtons(view)[0]?.click());
      await settle();

      expect(calls("computer/takeover")).toHaveLength(1);
      expect(calls("computer/boot")).toHaveLength(bootsBefore);
      expect(view.textContent).toContain("Request timed out");
      expect(view.textContent).not.toContain("Couldn't start the computer");
      expect(tryAgain(view)).toBeUndefined();
      expect(view.querySelector("section")).toBeNull();
    });

    it("keeps following the boot after the request times out", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const view = await render();
        const timeout = Object.defineProperty(new Error("Request timed out"), "name", {
          value: "TimeoutError",
        });
        status = { ...stopped, state: "booting" };
        await act(async () => boots[0]?.reject(timeout));
        await settle();

        expect(view.textContent).not.toContain("Request timed out");
        expect(view.textContent).not.toContain("Could not reach the server");
        expect(tryAgain(view)).toBeUndefined();

        await act(async () => vi.advanceTimersByTime(2000));
        await settle();
        expect(view.querySelector("progress")).not.toBeNull();
        expect(view.textContent).toContain("Booting live desktop…");

        status = idle;
        await act(async () => vi.advanceTimersByTime(2000));
        await settle();
        expect(view.querySelector("progress")).toBeNull();
        expect(view.querySelector("iframe")).not.toBeNull();
        expect(calls("computer/boot")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
