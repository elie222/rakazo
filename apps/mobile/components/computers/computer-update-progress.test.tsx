// @vitest-environment jsdom

import type { ComputerUpdate } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { ViewStyle } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerUpdateProgress } from "./computer-update-progress";

const { announce, start, dismiss, store, safeArea } = vi.hoisted(() => ({
  announce: vi.fn(),
  start: vi.fn(),
  dismiss: vi.fn(),
  store: { snapshot: { updates: [] as ComputerUpdate[], openId: null as string | null } },
  safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 }, rtl: false },
}));
vi.mock("../../lib/computers/computer-updates", () => ({
  computerUpdates: {
    subscribe: () => () => undefined,
    getSnapshot: () => store.snapshot,
    watch: () => undefined,
    open: vi.fn(),
    start,
    dismiss,
  },
}));
vi.mock("../../lib/api/roster-signals", () => ({ useLiveStream: () => undefined }));
vi.mock("expo-router", () => ({ usePathname: () => "/" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => safeArea.insets,
}));
vi.mock("../../lib/native/native", () => ({
  useMobileTokens: () => ({
    background: "#ffffff",
    foreground: "#000000",
    mutedForeground: "#666666",
    destructive: "#cc0000",
    glassFill: "#ffffff",
    glassStroke: "#000000",
  }),
}));
vi.mock("../native/glass-surface", () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    busy,
    onPress,
  }: {
    label: string;
    busy?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={busy} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: announce },
  ActivityIndicator: () => <span>Loading</span>,
  I18nManager: {
    get isRTL() {
      return safeArea.rtl;
    },
  },
  Modal: ({
    visible,
    children,
    presentationStyle,
  }: {
    visible: boolean;
    children?: ReactNode;
    presentationStyle?: string;
  }) => (visible ? <div data-presentation={presentationStyle}>{children}</div> : null),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => (
    <span role={accessibilityRole}>{children}</span>
  ),
  View: ({ children, style }: { children?: ReactNode; style?: ViewStyle | ViewStyle[] }) => {
    const flat: ViewStyle = Object.assign({}, ...[style].flat());
    // Native layout maps start and end to the physical edges of this direction.
    const start = flat.paddingStart ?? flat.paddingLeft;
    const end = flat.paddingEnd ?? flat.paddingRight;
    const horizontal = flat.paddingHorizontal ?? flat.padding;
    return (
      <div
        data-padding-left={(safeArea.rtl ? end : start) ?? horizontal}
        data-padding-right={(safeArea.rtl ? start : end) ?? horizontal}
        data-padding-top={flat.paddingTop ?? flat.padding}
      >
        {children}
      </div>
    );
  },
}));

const failedRecover: ComputerUpdate = {
  action: "recover",
  id: "update-1",
  botId: "bot-1",
  name: "Ada",
  mode: "dedicated",
  status: "failed",
  stage: "recreating",
};

describe("computer update progress", () => {
  let root: Root;
  let container: HTMLDivElement;
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === name);
  const click = (name: string) =>
    act(async () => {
      button(name)?.click();
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    safeArea.insets = { top: 0, bottom: 0, left: 0, right: 0 };
    safeArea.rtl = false;
    store.snapshot = { updates: [failedRecover], openId: failedRecover.id };
    start.mockRejectedValue(new Error("offline"));
    dismiss.mockRejectedValue(new Error("offline"));
    container = document.createElement("div");
    root = createRoot(container);
    act(() => root.render(<ComputerUpdateProgress />));
  });
  afterEach(() => act(() => root.unmount()));

  it.each([
    { direction: "LTR", left: 18, right: 54 },
    { direction: "RTL", left: 18, right: 54 },
  ])(
    "keeps $direction progress sheets inside left $left and right $right insets",
    ({ direction, left, right }) => {
      const update: ComputerUpdate = {
        ...failedRecover,
        action: "update",
        status: "running",
        mode: "team",
      };
      store.snapshot = { updates: [update], openId: update.id };
      safeArea.insets = { top: 20, bottom: 34, left, right };
      safeArea.rtl = direction === "RTL";
      act(() => root.render(<ComputerUpdateProgress />));

      const sheet = container.querySelector<HTMLElement>('[data-presentation="pageSheet"] > div');
      expect(sheet?.dataset.paddingLeft).toBe(`${24 + left}`);
      expect(sheet?.dataset.paddingRight).toBe(`${24 + right}`);
      expect(sheet?.dataset.paddingTop).toBe("24");
    },
  );

  it("announces each failed Recover, including a repeated one", async () => {
    await click("Recover computer");
    await vi.waitFor(() => expect(announce).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not complete action",
    );

    await click("Recover computer");
    await vi.waitFor(() => expect(announce).toHaveBeenCalledTimes(2));
    expect(announce).toHaveBeenNthCalledWith(2, "Could not complete action");
  });

  it("announces a failed Dismiss", async () => {
    await click("Dismiss");
    await vi.waitFor(() => expect(announce).toHaveBeenCalledOnce());
    expect(announce).toHaveBeenCalledWith("Could not complete action");
  });

  it("stays silent when Recover succeeds", async () => {
    start.mockResolvedValue(undefined);
    await click("Recover computer");
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(announce).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
