// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxSwipeRow } from "../components/inbox-swipe-row.ios";
import type { InboxRowAction } from "./inbox-swipe";
import {
  applyUnreadOverrides,
  chatTarget,
  createLatestQueue,
  inboxRowActionList,
  inboxRowActions,
  unreadOverrideKey,
} from "./inbox-swipe";

const testFileUrl = import.meta.url;

const swift = vi.hoisted(() => ({
  buttons: [] as Array<Record<string, unknown>>,
  groups: [] as Array<{ edge?: string; allowsFullSwipe?: boolean; labels: string[] }>,
}));

vi.mock("react-native", () => ({
  PlatformColor: (name: string) => ({ semantic: [name] }),
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./native", () => ({
  native: { page: "page" },
  useResolvedAppearance: () => "light",
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("@expo/ui/swift-ui", async () => {
  const { Children, isValidElement } = await import("react");
  const SwipeActions = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  SwipeActions.Actions = ({
    edge,
    allowsFullSwipe,
    children,
  }: {
    edge?: string;
    allowsFullSwipe?: boolean;
    children: ReactNode;
  }) => {
    const labels = Children.toArray(children).map((child) =>
      isValidElement<{ label: string }>(child) ? child.props.label : "",
    );
    swift.groups.push({ edge, allowsFullSwipe, labels });
    return <div>{children}</div>;
  };
  return {
    Host: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    List: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    RNHostView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SwipeActions,
    Button: (props: Record<string, unknown>) => {
      swift.buttons.push(props);
      return null;
    },
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (name: string) => (value: unknown) => ({ name, value });
  return Object.fromEntries(
    [
      "labelStyle",
      "listRowBackground",
      "listRowInsets",
      "listRowSeparator",
      "listStyle",
      "scrollContentBackground",
      "scrollDisabled",
      "tint",
    ].map((name) => [name, modifier(name)]),
  );
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  swift.buttons = [];
  swift.groups = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inbox row actions", () => {
  it.each([
    [{ unread: true, pinned: false }, "read", ["archive", "pin"]],
    [{ unread: false, pinned: false }, "unread", ["archive", "pin"]],
    [{ unread: true, pinned: true }, "read", ["archive", "unpin"]],
    [{ unread: false, pinned: true }, "unread", ["archive", "unpin"]],
  ] as const)(
    "offers read state leading and archive, then pin trailing for %o",
    (chat, leading, trailing) => {
      expect(inboxRowActions(chat)).toEqual({ leading, trailing });
      expect(inboxRowActionList(chat)).toEqual([leading, ...trailing]);
    },
  );

  it("targets bots and groups by their own id", () => {
    expect(chatTarget("bot", "b1")).toEqual({ botId: "b1" });
    expect(chatTarget("group", "g1")).toEqual({ groupId: "g1" });
  });

  it("shows a pending read state over a stale poll and keeps untouched rows", () => {
    const polled = [
      { id: "a", unread: false },
      { id: "b", unread: true },
    ];
    expect(applyUnreadOverrides("bot", polled, new Map())).toBe(polled);
    const shown = applyUnreadOverrides(
      "bot",
      polled,
      new Map([
        [unreadOverrideKey("bot", "a"), true],
        [unreadOverrideKey("group", "b"), false],
      ]),
    );
    expect(shown).toEqual([
      { id: "a", unread: true },
      { id: "b", unread: true },
    ]);
    expect(shown[1]).toBe(polled[1]);
  });
});

describe("latest queue", () => {
  it("runs one request per key and settles after the newest value", async () => {
    const send = createLatestQueue<number>();
    const sent: Array<[string, number]> = [];
    const pending: Array<() => void> = [];
    const settled = vi.fn();
    const request = (key: string) => (value: number) => {
      sent.push([key, value]);
      return new Promise<void>((resolve) => pending.push(resolve));
    };
    const a = send("a", 1, request("a"), settled);
    void send("a", 2, request("a"), settled);
    void send("a", 3, request("a"), settled);
    const b = send("b", 1, request("b"), settled);
    expect(sent).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    pending.shift()!();
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toEqual(["a", 3]);
    expect(settled).not.toHaveBeenCalled();
    pending.shift()!();
    await b;
    pending.shift()!();
    await a;
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it("settles and rejects when a request fails", async () => {
    const send = createLatestQueue<boolean>();
    const settled = vi.fn();
    await expect(
      send("a", true, () => Promise.reject(new Error("offline")), settled),
    ).rejects.toThrow("offline");
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

describe("iOS swipe row", () => {
  function render(rows: Array<{ key: string; unread?: boolean; pinned?: boolean }>) {
    const onAction = vi.fn<(key: string, action: InboxRowAction) => void>();
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        rows.map((row) => (
          <InboxSwipeRow
            key={row.key}
            rowKey={row.key}
            unread={row.unread}
            pinned={row.pinned}
            onAction={(action) => onAction(row.key, action)}
          >
            <span>{row.key}</span>
          </InboxSwipeRow>
        )),
      ),
    );
    return { onAction, root };
  }

  it("uses system swipe actions with a full swipe only on the read toggle", () => {
    const { onAction, root } = render([{ key: "bot:1", unread: true, pinned: true }]);
    expect(swift.groups).toEqual([
      { edge: "leading", allowsFullSwipe: undefined, labels: ["Mark as Read"] },
      { edge: "trailing", allowsFullSwipe: false, labels: ["Archive", "Unpin"] },
    ]);
    expect(swift.buttons.map(({ label, systemImage, role }) => [label, systemImage, role])).toEqual(
      [
        ["Mark as Read", "checkmark.message.fill", undefined],
        ["Archive", "eye.slash", "destructive"],
        ["Unpin", "pin.slash", undefined],
      ],
    );
    expect(swift.buttons[0]!.modifiers).toContainEqual({
      name: "tint",
      value: { semantic: ["systemBlue"] },
    });
    for (const button of swift.buttons) (button.onPress as () => void)();
    expect(onAction.mock.calls).toEqual([
      ["bot:1", "read"],
      ["bot:1", "archive"],
      ["bot:1", "unpin"],
    ]);
    act(() => root.unmount());
  });
});

describe("inbox swipe handlers", () => {
  const source = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8");
  const handlerSource = source.slice(
    source.indexOf("  // One path for the long-press sheet and the swipe actions."),
    source.indexOf("  const botAction = useCallback("),
  );

  const session = { space: "space-a", generation: 1 };
  beforeEach(() => {
    session.space = "space-a";
    session.generation = 1;
  });
  const sent = (call: unknown[]) => call.slice(0, 2);

  function handlers(
    rpc: (procedure: string, input: unknown, options?: unknown) => Promise<unknown>,
  ) {
    const state = {
      overrides: new Map<string, boolean>() as ReadonlyMap<string, boolean>,
      bots: [{ id: "b1", unread: false }],
      groups: [{ id: "g1", unread: true }],
    };
    const update =
      <K extends keyof typeof state>(key: K) =>
      (next: (typeof state)[K] | ((current: (typeof state)[K]) => (typeof state)[K])) => {
        state[key] = typeof next === "function" ? next(state[key]) : next;
      };
    const scope = {
      useCallback: (callback: unknown) => callback,
      useState: <T,>(init: () => T) => [init()],
      createLatestQueue,
      rpc: vi.fn(rpc),
      loadBots: vi.fn(async () => {}),
      setUnreadOverrides: update("overrides"),
      setBots: update("bots"),
      setGroups: update("groups"),
      Alert: { alert: vi.fn() },
      t: (text: string) => text,
      errorText: (_error: unknown, fallback: string) => fallback,
      chatTarget,
      unreadOverrideKey,
      resumeLiveNotifications: vi.fn(async () => {}),
      dismissThreadNotifications: vi.fn(async () => {}),
      currentApiBase: () => "",
      loadSessionToken: async () => null,
      selectedSpaceId: () => session.space,
      currentSessionGeneration: () => session.generation,
      captureApiRequestContext: async () => ({
        apiBase: "",
        headers: { authorization: "Bearer token", "x-rakazo-space-id": session.space },
        sessionGeneration: session.generation,
      }),
    };
    const compiled = ts.transpileModule(`${handlerSource}\nreturn { updateChat, runRowAction };`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const run = new Function(...Object.keys(scope), compiled)(...Object.values(scope)) as {
      runRowAction: (
        kind: "bot" | "group",
        chat: { id: string },
        action: InboxRowAction,
      ) => Promise<void>;
    };
    return { ...scope, state, runRowAction: run.runRowAction };
  }

  it("sends overlapping read changes for one chat in order and keeps the newest on screen", async () => {
    const pending: Array<() => void> = [];
    const h = handlers(() => new Promise<void>((resolve) => pending.push(resolve)));
    const first = h.runRowAction("bot", { id: "b1" }, "unread");
    const second = h.runRowAction("bot", { id: "b1" }, "read");
    await second;
    // The second change waits for the first instead of racing it.
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(sent(h.rpc.mock.calls[0]!)).toEqual(["threads/markUnread", { botId: "b1" }]);
    expect(h.state.overrides.get("bot:b1")).toBe(false);
    pending.shift()!();
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(2));
    expect(sent(h.rpc.mock.calls[1]!)).toEqual(["threads/markRead", { botId: "b1" }]);
    // The first request finishing must not clear the newer choice.
    expect(h.state.overrides.get("bot:b1")).toBe(false);
    pending.shift()!();
    await first;
    expect(h.state.bots[0]!.unread).toBe(false);
    expect(h.state.overrides.size).toBe(0);
  });

  it("drops a change that is undone before its turn", async () => {
    const pending: Array<() => void> = [];
    const h = handlers(() => new Promise<void>((resolve) => pending.push(resolve)));
    const first = h.runRowAction("group", { id: "g1" }, "read");
    void h.runRowAction("group", { id: "g1" }, "unread");
    void h.runRowAction("group", { id: "g1" }, "read");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()!();
    await first;
    expect(h.rpc.mock.calls.map(sent)).toEqual([["threads/markRead", { groupId: "g1" }]]);
    expect(h.state.groups[0]!.unread).toBe(false);
    expect(h.state.overrides.size).toBe(0);
  });

  it("sends a queued change in the Space it was swiped in after a Space switch", async () => {
    const pending: Array<() => void> = [];
    const h = handlers(() => new Promise<void>((resolve) => pending.push(resolve)));
    const first = h.runRowAction("bot", { id: "b1" }, "unread");
    void h.runRowAction("bot", { id: "b1" }, "read");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    session.space = "space-b";
    pending.shift()!();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const spaces = h.rpc.mock.calls.map(
      (call) =>
        (call[2] as { requestContext: { headers: Record<string, string> } }).requestContext.headers[
          "x-rakazo-space-id"
        ],
    );
    expect(spaces).toEqual(["space-a", "space-a"]);
    pending.shift()!();
    await first;
  });

  it("drops queued changes quietly once the session changes", async () => {
    const pending: Array<() => void> = [];
    const h = handlers(() => new Promise<void>((resolve) => pending.push(resolve)));
    const first = h.runRowAction("bot", { id: "b1" }, "unread");
    void h.runRowAction("bot", { id: "b1" }, "read");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    session.generation = 2;
    pending.shift()!();
    await first;
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.state.overrides.size).toBe(0);
    expect(h.Alert.alert).not.toHaveBeenCalled();
  });

  it("marks unread optimistically, keeps it through the request, then refreshes", async () => {
    let finish!: () => void;
    const h = handlers(() => new Promise<void>((resolve) => (finish = resolve)));
    const pending = h.runRowAction("bot", { id: "b1" }, "unread");
    await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(sent(h.rpc.mock.calls[0]!)).toEqual(["threads/markUnread", { botId: "b1" }]);
    expect(h.state.overrides.get("bot:b1")).toBe(true);
    // A poll landing now still shows the stale server value underneath the override.
    expect(applyUnreadOverrides("bot", h.state.bots, h.state.overrides)[0]!.unread).toBe(true);
    finish();
    await pending;
    expect(h.state.bots[0]!.unread).toBe(true);
    expect(h.loadBots).toHaveBeenCalledTimes(1);
    expect(h.state.overrides.size).toBe(0);
    expect(h.Alert.alert).not.toHaveBeenCalled();
  });

  it("rolls a failed read change back and uses the native alert", async () => {
    const h = handlers(async () => {
      throw new Error("offline");
    });
    await h.runRowAction("group", { id: "g1" }, "read");
    expect(sent(h.rpc.mock.calls[0]!)).toEqual(["threads/markRead", { groupId: "g1" }]);
    expect(h.state.overrides.size).toBe(0);
    expect(h.state.groups[0]!.unread).toBe(true);
    expect(h.Alert.alert).toHaveBeenCalledWith("Could not update chat", "Try again.");
  });

  it.each([
    ["bot", "archive", "bots/archive", { botId: "x" }],
    ["group", "archive", "groups/archive", { groupId: "x" }],
    ["bot", "pin", "bots/update", { botId: "x", pinned: true }],
    ["group", "unpin", "groups/update", { groupId: "x", pinned: false }],
  ] as const)("%s %s calls %s and refreshes the inbox", async (kind, action, procedure, input) => {
    const h = handlers(async () => ({ ok: true }));
    await h.runRowAction(kind, { id: "x" }, action);
    expect(h.rpc.mock.calls).toEqual([[procedure, input]]);
    expect(h.loadBots).toHaveBeenCalledTimes(1);
  });

  it("names the archive failure for bots", async () => {
    const h = handlers(async () => {
      throw new Error("nope");
    });
    await h.runRowAction("bot", { id: "x" }, "archive");
    await h.runRowAction("group", { id: "x" }, "pin");
    expect(h.Alert.alert.mock.calls.map(([title]) => title)).toEqual([
      "Could not archive bot",
      "Could not update chat",
    ]);
  });
});
