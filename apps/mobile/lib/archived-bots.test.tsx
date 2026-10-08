// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ArchivedBots from "../app/archived-bots";
import { ComputerMaintenanceActions } from "../components/computer-maintenance-actions";
import type { MobileBot } from "./api";

const { rpc, alert, push, navigation, focus } = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  push: vi.fn(),
  navigation: { setOptions: vi.fn() },
  focus: { current: undefined as (() => (() => void) | undefined) | undefined },
}));
const bot = { id: "bot-fixture", name: "Fixture" } as MobileBot;
vi.mock("./api", () => ({ rpc }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push }),
  useNavigation: () => navigation,
  useFocusEffect: (effect: () => (() => void) | undefined) => {
    focus.current = effect;
    useEffect(effect, [effect]);
  },
}));
vi.mock("react-native", () => ({
  Alert: { alert },
  ActivityIndicator: () => null,
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("./native", () => ({
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("./floating-header", () => ({ useFloatingHeaderInset: () => 0 }));
vi.mock("./native-controls", () => ({ iosAtLeast: () => true }));
vi.mock("./computer-updates", () => ({ computerUpdates: { start: vi.fn() } }));
vi.mock("@expo/ui/community/menu", () => ({ MenuView: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("../components/archived-bot-list", () => ({
  ArchivedBotList: ({
    bots,
    onOpen,
    onRestore,
    onDelete,
  }: {
    bots: MobileBot[];
    onOpen: (bot: MobileBot) => void;
    onRestore: (bot: MobileBot) => void;
    onDelete: (bot: MobileBot) => void;
  }) =>
    createElement(
      "div",
      null,
      ...bots.map((item) =>
        createElement(
          "div",
          { key: item.id },
          createElement("button", { type: "button", onClick: () => onOpen(item) }, item.name),
          createElement("button", { type: "button", onClick: () => onRestore(item) }, "Restore"),
          createElement("button", { type: "button", onClick: () => onDelete(item) }, "Delete"),
        ),
      ),
    ),
}));

describe("archived chat read failures", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    rpc.mockResolvedValue([bot]);
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root.render(<ArchivedBots />));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it.each([new TypeError("Network request failed"), new Error("Request timed out")])(
    "retries a failed read without restoring the bot: %s",
    async (cause) => {
      rpc.mockRejectedValueOnce(cause);
      await act(async () => container.querySelector("button")!.click());
      expect(push).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledWith("Could not load bot", expect.any(String), [
        { text: "Cancel", style: "cancel" },
        { text: "Try again.", onPress: expect.any(Function) },
      ]);
      rpc.mockResolvedValueOnce({});
      await act(async () => alert.mock.calls[0]![2][1].onPress());
      expect(push).toHaveBeenCalledWith({
        pathname: "/thread",
        params: { botId: bot.id, name: bot.name, readOnly: "1" },
      });
      expect(rpc.mock.calls.map(([procedure]) => procedure)).toEqual([
        "bots/listArchived",
        "threads/get",
        "threads/get",
      ]);
    },
  );

  it("keeps explicit restoration available after a server rejects the read", async () => {
    rpc.mockRejectedValueOnce(new Error("Internal server error"));
    await act(async () => container.querySelector("button")!.click());
    expect(push).not.toHaveBeenCalled();
    rpc.mockResolvedValueOnce({ ok: true });
    await act(async () => container.querySelectorAll("button")[1]!.click());
    expect(rpc).toHaveBeenLastCalledWith("bots/restore", { botId: bot.id });
    expect(container.textContent).toBe("No archived bots");
    expect(push).not.toHaveBeenCalled();
  });

  it.each(["Restore", "Delete"])("ignores a stale refresh after %s succeeds", async (action) => {
    let finishRefresh!: (bots: MobileBot[]) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise<MobileBot[]>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    await act(async () => {
      focus.current!();
    });
    rpc.mockResolvedValueOnce({ ok: true });
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === action,
    )!;
    await act(async () => button.click());
    if (action === "Delete") {
      await act(async () => alert.mock.calls[0]![2][1].onPress());
    }
    expect(container.textContent).toBe("No archived bots");
    await act(async () => finishRefresh([bot]));
    expect(container.textContent).toBe("No archived bots");
  });

  it("keeps loaded rows usable and retries a failed list refresh", async () => {
    rpc.mockRejectedValueOnce(new Error("Could not reach the server"));
    await act(async () => {
      focus.current!();
    });
    expect(container.textContent).toContain(bot.name);
    expect(container.textContent).toContain("Could not reach the server");
    const retry = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Try again.",
    )!;
    rpc.mockResolvedValueOnce([]);
    await act(async () => retry.click());
    expect(container.textContent).toBe("No archived bots");
  });

  it("clears a computer's native header menu when its actions unmount", async () => {
    await act(async () =>
      root.render(
        <ComputerMaintenanceActions
          botId="bot-fixture"
          computer={{ state: "running" } as ComputerStatus}
          onChanged={async () => {}}
        />,
      ),
    );
    expect(navigation.setOptions.mock.lastCall![0].unstable_headerRightItems()).toHaveLength(1);
    await act(async () => root.render(null));
    expect(navigation.setOptions.mock.lastCall![0].unstable_headerRightItems()).toEqual([]);
  });
});
