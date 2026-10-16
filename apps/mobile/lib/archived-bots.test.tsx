// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ArchivedBots from "../app/(settings)/archived-bots";
import { ComputerMaintenanceActions } from "../components/computer-maintenance-actions";
import type { MobileBot, MobileGroup } from "./api";

const { rpc, groupRpc, alert, push, closeSettingsSheet, navigation, focus } = vi.hoisted(() => ({
  rpc: vi.fn(),
  // Archived groups load beside the bots; their calls are kept apart from the bot call queue.
  groupRpc: vi.fn(),
  closeSettingsSheet: vi.fn(),
  alert: vi.fn(),
  push: vi.fn(),
  navigation: { setOptions: vi.fn() },
  focus: { current: undefined as (() => (() => void) | undefined) | undefined },
}));
const bot = { id: "bot-fixture", name: "Fixture" } as MobileBot;
const group = { id: "group-fixture", name: "Crew" } as MobileGroup;
vi.mock("./api", () => ({
  rpc: (procedure: string, ...args: unknown[]) =>
    procedure.startsWith("groups/") ? groupRpc(procedure, ...args) : rpc(procedure, ...args),
}));
vi.mock("./settings-sheet", () => ({ closeSettingsSheet }));
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
    groups,
    onOpen,
    onRestore,
    onDelete,
    onRestoreGroup,
  }: {
    bots: MobileBot[];
    groups: MobileGroup[];
    onOpen: (bot: MobileBot) => void;
    onRestore: (bot: MobileBot) => void;
    onDelete: (bot: MobileBot) => void;
    onRestoreGroup: (group: MobileGroup) => void;
  }) =>
    createElement(
      "div",
      null,
      ...groups.map((item) =>
        createElement(
          "button",
          { key: item.id, type: "button", onClick: () => onRestoreGroup(item) },
          `Restore ${item.name}`,
        ),
      ),
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
    groupRpc.mockResolvedValue([]);
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
      expect(closeSettingsSheet.mock.invocationCallOrder[0]).toBeLessThan(
        push.mock.invocationCallOrder[0] ?? 0,
      );
      expect(rpc.mock.calls.map(([procedure]) => procedure)).toEqual([
        "bots/listArchived",
        "threads/get",
        "threads/get",
      ]);
    },
  );

  it.each(["left", "left and came back"])(
    "does not close settings or open the chat when its read finishes after the page was %s",
    async (path) => {
      let finishRead!: (value: unknown) => void;
      rpc.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      );
      await act(async () => container.querySelector("button")!.click());
      if (path === "left") await act(async () => root.render(null));
      else
        await act(async () => {
          focus.current!()?.();
          focus.current!();
        });
      await act(async () => finishRead({}));
      expect(closeSettingsSheet).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    },
  );

  it.each(["resolve", "reject"])(
    "ignores a stale read that %ss after dismissing and reopening the sheet",
    async (outcome) => {
      let finishRead!: (value: unknown) => void;
      let failRead!: (cause: Error) => void;
      rpc.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finishRead = resolve;
            failRead = reject;
          }),
      );
      await act(async () => container.querySelector("button")!.click());
      await act(async () => root.render(null));
      await act(async () => root.render(<ArchivedBots />));
      expect(container.textContent).toContain(bot.name);
      await act(async () => {
        if (outcome === "resolve") finishRead({});
        else failRead(new Error("Request timed out"));
      });
      expect(closeSettingsSheet).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(alert).not.toHaveBeenCalled();

      rpc.mockResolvedValueOnce({});
      await act(async () => container.querySelector("button")!.click());
      expect(closeSettingsSheet).toHaveBeenCalledTimes(1);
      expect(push).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores a failed read after blur and permits a new read on refocus", async () => {
    let failRead!: (cause: Error) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRead = reject;
        }),
    );
    await act(async () => container.querySelector("button")!.click());
    await act(async () => {
      focus.current!()?.();
      focus.current!();
    });
    await act(async () => failRead(new Error("Request timed out")));
    expect(alert).not.toHaveBeenCalled();
    rpc.mockResolvedValueOnce({});
    await act(async () => container.querySelector("button")!.click());
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("keeps a new read pending when an older focus's read finishes", async () => {
    const reads: ((value: unknown) => void)[] = [];
    rpc.mockImplementation((procedure) => {
      if (procedure === "bots/listArchived") return Promise.resolve([bot]);
      return new Promise((resolve) => reads.push(resolve));
    });
    await act(async () => container.querySelector("button")!.click());
    await act(async () => {
      focus.current!()?.();
      focus.current!();
    });
    await act(async () => container.querySelector("button")!.click());
    expect(reads).toHaveLength(2);
    await act(async () => reads[0]!({}));
    await act(async () => container.querySelector("button")!.click());
    expect(reads).toHaveLength(2);
    expect(push).not.toHaveBeenCalled();
    await act(async () => reads[1]!({}));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("ignores a retry alert from a dismissed sheet", async () => {
    rpc.mockRejectedValueOnce(new Error("Request timed out"));
    await act(async () => container.querySelector("button")!.click());
    const retry = alert.mock.calls[0]![2][1].onPress;
    await act(async () => root.render(null));
    await act(async () => root.render(<ArchivedBots />));
    await act(async () => retry());
    expect(rpc.mock.calls.filter(([procedure]) => procedure === "threads/get")).toHaveLength(1);
    expect(closeSettingsSheet).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps explicit restoration available after a server rejects the read", async () => {
    rpc.mockRejectedValueOnce(new Error("Internal server error"));
    await act(async () => container.querySelector("button")!.click());
    expect(push).not.toHaveBeenCalled();
    rpc.mockResolvedValueOnce({ ok: true });
    await act(async () => container.querySelectorAll("button")[1]!.click());
    expect(rpc).toHaveBeenLastCalledWith("bots/restore", { botId: bot.id });
    expect(container.textContent).toBe("No archived chats");
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
    // The stale refresh is restarted after the change, and the server no longer lists the bot.
    rpc.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce([]);
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === action,
    )!;
    await act(async () => button.click());
    if (action === "Delete") {
      await act(async () => alert.mock.calls[0]![2][1].onPress());
    }
    expect(container.textContent).toBe("No archived chats");
    await act(async () => finishRefresh([bot]));
    expect(container.textContent).toBe("No archived chats");
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
    expect(container.textContent).toBe("No archived chats");
  });

  it("lists archived groups and restores one", async () => {
    groupRpc.mockResolvedValueOnce([group]);
    await act(async () => {
      focus.current!();
    });
    expect(groupRpc).toHaveBeenCalledWith("groups/listArchived", {}, expect.anything());
    const restore = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Restore Crew",
    )!;
    groupRpc.mockResolvedValueOnce({ ok: true });
    await act(async () => restore.click());
    expect(groupRpc).toHaveBeenLastCalledWith("groups/restore", { groupId: group.id });
    expect(container.textContent).not.toContain("Restore Crew");
    expect(container.textContent).toContain(bot.name);
  });

  it("keeps a group whose restore fails and uses the native alert", async () => {
    groupRpc.mockResolvedValueOnce([group]);
    await act(async () => {
      focus.current!();
    });
    groupRpc.mockRejectedValueOnce(new Error("offline"));
    const restore = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Restore Crew",
    )!;
    await act(async () => restore.click());
    expect(alert).toHaveBeenCalledWith("Could not update chat", "offline");
    expect(container.textContent).toContain("Restore Crew");
  });

  it("shows archived groups when no bots are archived", async () => {
    rpc.mockResolvedValueOnce([]);
    groupRpc.mockResolvedValueOnce([group]);
    await act(async () => {
      focus.current!();
    });
    expect(container.textContent).toBe("Restore Crew");
  });

  it("names chats when the archived lists fail to load", async () => {
    await act(async () => root.render(null));
    rpc.mockResolvedValueOnce([]);
    groupRpc.mockRejectedValueOnce(new Error(""));
    await act(async () => root.render(<ArchivedBots />));
    expect(container.textContent).toContain("Could not load chats");
  });

  it("shows archived bots when the groups list fails", async () => {
    await act(async () => root.render(null));
    groupRpc.mockRejectedValueOnce(new Error(""));
    await act(async () => root.render(<ArchivedBots />));
    expect(container.textContent).toContain(bot.name);
    expect(container.textContent).toContain("Could not load chats");
  });

  it("doesn't drop a later visit's list when a group restore finishes after leaving", async () => {
    groupRpc.mockResolvedValueOnce([group]);
    await act(async () => {
      focus.current!();
    });
    let finishRestore!: (value: unknown) => void;
    groupRpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRestore = resolve;
        }),
    );
    const restore = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Restore Crew",
    )!;
    await act(async () => restore.click());
    let finishList!: (value: MobileBot[]) => void;
    // Leaving runs one more load that is aborted at once; the return visit's load stays open
    // until the restore finishes and refreshes it.
    rpc
      .mockResolvedValueOnce([bot])
      .mockImplementationOnce(
        () =>
          new Promise<MobileBot[]>((resolve) => {
            finishList = resolve;
          }),
      )
      .mockResolvedValueOnce([]);
    groupRpc.mockResolvedValueOnce([group]).mockResolvedValueOnce([]);
    await act(async () => {
      focus.current!()?.();
      focus.current!();
    });
    await act(async () => finishRestore({ ok: true }));
    await act(async () => finishList([]));
    expect(container.textContent).toBe("No archived chats");
  });

  it("keeps the bots load error after restoring the last group", async () => {
    await act(async () => root.render(null));
    rpc.mockRejectedValueOnce(new Error(""));
    groupRpc.mockResolvedValueOnce([group]);
    await act(async () => root.render(<ArchivedBots />));
    groupRpc.mockResolvedValueOnce({ ok: true });
    const restore = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Restore Crew",
    )!;
    await act(async () => restore.click());
    expect(container.textContent).toBe("Could not load chatsTry again.");
  });

  it("keeps the groups load error after restoring the last bot", async () => {
    await act(async () => root.render(null));
    groupRpc.mockRejectedValueOnce(new Error(""));
    await act(async () => root.render(<ArchivedBots />));
    rpc.mockResolvedValueOnce({ ok: true });
    const restore = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Restore",
    )!;
    await act(async () => restore.click());
    expect(container.textContent).toBe("Could not load chatsTry again.");
  });

  it("keeps a bots retry that is running when a group is restored", async () => {
    await act(async () => root.render(null));
    rpc.mockRejectedValueOnce(new Error(""));
    groupRpc.mockResolvedValueOnce([group]);
    await act(async () => root.render(<ArchivedBots />));
    let finishRetry!: (value: MobileBot[]) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise<MobileBot[]>((resolve) => {
          finishRetry = resolve;
        }),
    );
    groupRpc.mockResolvedValueOnce([group]);
    const retry = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Try again.",
    )!;
    await act(async () => retry.click());
    groupRpc.mockResolvedValueOnce({ ok: true });
    const restore = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Restore Crew",
    )!;
    await act(async () => restore.click());
    await act(async () => finishRetry([bot]));
    expect(container.textContent).toContain(bot.name);
    expect(container.textContent).not.toContain("Could not load chats");
    expect(container.textContent).not.toContain("Restore Crew");
  });

  it("refreshes a later visit when a group restore from an earlier visit finishes", async () => {
    await act(async () => root.render(null));
    groupRpc.mockResolvedValueOnce([group]);
    await act(async () => root.render(<ArchivedBots />));
    let finishRestore!: (value: unknown) => void;
    groupRpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRestore = resolve;
        }),
    );
    const restore = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Restore Crew",
    )!;
    await act(async () => restore.click());
    groupRpc.mockResolvedValueOnce([group]).mockResolvedValueOnce([group]);
    await act(async () => {
      focus.current!()?.();
      focus.current!();
    });
    expect(container.textContent).toContain("Restore Crew");
    await act(async () => finishRestore({ ok: true }));
    expect(container.textContent).not.toContain("Restore Crew");
    expect(container.textContent).toContain(bot.name);
  });

  it("doesn't alert for a group restore that fails after leaving", async () => {
    await act(async () => root.render(null));
    groupRpc.mockResolvedValueOnce([group]);
    await act(async () => root.render(<ArchivedBots />));
    let failRestore!: (cause: Error) => void;
    groupRpc.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRestore = reject;
        }),
    );
    const restore = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Restore Crew",
    )!;
    await act(async () => restore.click());
    await act(async () => root.render(null));
    await act(async () => failRestore(new Error("offline")));
    expect(alert).not.toHaveBeenCalled();
  });

  it.each(["Restore", "Delete"])(
    "keeps a groups retry that is running when a bot %s succeeds",
    async (action) => {
      await act(async () => root.render(null));
      groupRpc.mockRejectedValueOnce(new Error(""));
      await act(async () => root.render(<ArchivedBots />));
      let finishRetry!: (value: MobileGroup[]) => void;
      groupRpc.mockImplementationOnce(
        () =>
          new Promise<MobileGroup[]>((resolve) => {
            finishRetry = resolve;
          }),
      );
      rpc.mockResolvedValueOnce([bot]);
      const retry = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === "Try again.",
      )!;
      await act(async () => retry.click());
      rpc.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce([]);
      groupRpc.mockResolvedValueOnce([group]);
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === action,
      )!;
      await act(async () => button.click());
      if (action === "Delete") await act(async () => alert.mock.calls[0]![2][1].onPress());
      await act(async () => finishRetry([group]));
      expect(container.textContent).toBe("Restore Crew");
    },
  );

  it.each(["Restore", "Delete"])(
    "refreshes a later visit when a bot %s from an earlier visit finishes",
    async (action) => {
      let finish!: (value: unknown) => void;
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === action,
      )!;
      if (action === "Delete") await act(async () => button.click());
      rpc.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      if (action === "Delete") await act(async () => alert.mock.calls[0]![2][1].onPress());
      else await act(async () => button.click());
      await act(async () => {
        focus.current!()?.();
        focus.current!();
      });
      expect(container.textContent).toContain(bot.name);
      rpc.mockResolvedValueOnce([]);
      await act(async () => finish({ ok: true }));
      expect(container.textContent).toBe("No archived chats");
    },
  );

  it.each(["Restore", "Delete"])(
    "doesn't alert for a bot %s that fails after leaving",
    async (action) => {
      let fail!: (cause: Error) => void;
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === action,
      )!;
      if (action === "Delete") await act(async () => button.click());
      rpc.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      );
      if (action === "Delete") await act(async () => alert.mock.calls[0]![2][1].onPress());
      else await act(async () => button.click());
      const alerts = alert.mock.calls.length;
      await act(async () => root.render(null));
      await act(async () => fail(new Error("offline")));
      expect(alert).toHaveBeenCalledTimes(alerts);
    },
  );

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
