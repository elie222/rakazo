// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxSwipeRowProps } from "../components/inbox-swipe-row";
import { InboxSwipeRow } from "../components/inbox-swipe-row.ios";
import type { MobileBotSection } from "./api";
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
  groups: [] as Array<{ edge?: string; allowsFullSwipe?: boolean; labels: string[] }>,
}));

vi.mock("react-native", () => ({
  PlatformColor: (name: string) => ({ semantic: [name] }),
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./native", () => ({
  native: { page: "page", fill: "fill" },
  useResolvedAppearance: () => "light",
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
// SwiftUI views render as plain DOM so tests can read the row's structure.
vi.mock("@expo/ui/swift-ui", async () => {
  const { Children, isValidElement } = await import("react");
  const box =
    (name: string) =>
    ({ children }: { children?: ReactNode }) => <div data-ui={name}>{children}</div>;
  const SwipeActions = box("SwipeActions") as ReturnType<typeof box> & {
    Actions: (props: {
      edge?: string;
      allowsFullSwipe?: boolean;
      children: ReactNode;
    }) => ReactNode;
  };
  SwipeActions.Actions = ({ edge, allowsFullSwipe, children }) => {
    const labels = Children.toArray(children).map((child) =>
      isValidElement<{ label: string }>(child) ? child.props.label : "",
    );
    swift.groups.push({ edge, allowsFullSwipe, labels });
    return <div data-ui="SwipeActions.Actions">{children}</div>;
  };
  const ContextMenu = Object.assign(box("ContextMenu"), {
    Trigger: box("ContextMenu.Trigger"),
    Preview: box("ContextMenu.Preview"),
    Items: box("ContextMenu.Items"),
  });
  return {
    Host: box("Host"),
    List: box("List"),
    RNHostView: box("RNHostView"),
    VStack: box("VStack"),
    HStack: box("HStack"),
    Text: ({ children }: { children?: ReactNode }) => <span data-ui="Text">{children}</span>,
    Spacer: () => null,
    Divider: () => <hr />,
    SwipeActions,
    ContextMenu,
    Menu: ({
      label,
      systemImage,
      children,
    }: {
      label: string;
      systemImage?: string;
      children: ReactNode;
    }) => (
      <div data-ui="Menu" data-label={label} data-image={systemImage}>
        {children}
      </div>
    ),
    Toggle: ({
      label,
      isOn,
      onIsOnChange,
    }: {
      label: string;
      isOn: boolean;
      onIsOnChange: (isOn: boolean) => void;
    }) => (
      <button
        type="button"
        data-ui="Toggle"
        data-label={label}
        data-on={String(isOn)}
        onClick={() => onIsOnChange(!isOn)}
      />
    ),
    Button: ({
      label,
      systemImage,
      role,
      modifiers,
      onPress,
    }: {
      label: string;
      systemImage?: string;
      role?: string;
      modifiers?: unknown[];
      onPress: () => void;
    }) => (
      <button
        type="button"
        data-ui="Button"
        data-label={label}
        data-image={systemImage}
        data-role={role}
        data-modifiers={JSON.stringify(modifiers ?? [])}
        onClick={onPress}
      />
    ),
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (name: string) => (value: unknown) => ({ name, value });
  return {
    shapes: { roundedRectangle: (value: unknown) => ({ shape: "roundedRectangle", value }) },
    ...Object.fromEntries(
      [
        "background",
        "font",
        "foregroundStyle",
        "frame",
        "labelStyle",
        "lineLimit",
        "listRowBackground",
        "listRowInsets",
        "listRowSeparator",
        "listStyle",
        "padding",
        "scrollContentBackground",
        "scrollDisabled",
        "tint",
      ].map((name) => [name, modifier(name)]),
    ),
  };
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  const sections = [
    { id: "s1", name: "Work" },
    { id: "s2", name: "Home" },
  ] as MobileBotSection[];

  function render(
    row: Partial<InboxSwipeRowProps> & { key?: string } = {},
    preview: InboxSwipeRowProps["preview"] = { title: "Ada", message: "Hi", avatar: <i /> },
  ) {
    const key = row.key ?? "bot:1";
    const onAction = vi.fn<(action: InboxRowAction) => void>();
    const onOrganize = vi.fn<InboxSwipeRowProps["onOrganize"]>();
    const onEditSection = vi.fn<InboxSwipeRowProps["onEditSection"]>();
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <InboxSwipeRow
          rowKey={key}
          sections={sections}
          preview={preview}
          onAction={onAction}
          onOrganize={onOrganize}
          onEditSection={onEditSection}
          {...row}
        >
          <span>{key}</span>
        </InboxSwipeRow>,
      ),
    );
    const find = (selector: string) => container.querySelector<HTMLElement>(selector);
    const items = find('[data-ui="ContextMenu.Items"]')!;
    const press = (label: string) =>
      act(() => items.querySelector<HTMLElement>(`[data-label="${label}"]`)!.click());
    return { container, find, items, press, onAction, onOrganize, onEditSection, root };
  }

  const entry = (item: Element) => [
    item.getAttribute("data-label"),
    item.getAttribute("data-image") ?? item.getAttribute("data-on"),
    item.getAttribute("data-role"),
  ];
  const entries = (parent: Element) =>
    Array.from(parent.children)
      .filter((child) => child.getAttribute("data-ui"))
      .map(entry);

  it("uses system swipe actions with a full swipe only on the read toggle", () => {
    const { container, onAction, root } = render({ unread: true, pinned: true });
    expect(swift.groups).toEqual([
      { edge: "leading", allowsFullSwipe: undefined, labels: ["Mark as Read"] },
      { edge: "trailing", allowsFullSwipe: false, labels: ["Archive", "Unpin"] },
    ]);
    const buttons = Array.from(
      container.querySelectorAll<HTMLElement>('[data-ui="SwipeActions.Actions"] > button'),
    );
    expect(buttons.map(entry)).toEqual([
      ["Mark as Read", "checkmark.message.fill", null],
      ["Archive", "eye.slash", "destructive"],
      ["Unpin", "pin.slash", null],
    ]);
    expect(JSON.parse(buttons[0]!.dataset.modifiers!)).toContainEqual({
      name: "tint",
      value: { semantic: ["systemBlue"] },
    });
    act(() => {
      for (const button of buttons) button.click();
    });
    expect(onAction.mock.calls).toEqual([["read"], ["archive"], ["unpin"]]);
    act(() => root.unmount());
  });

  it("opens the system context menu with a preview on the same list row as the swipe actions", () => {
    const { find, root } = render();
    const menu = find('[data-ui="SwipeActions"] > [data-ui="ContextMenu"]');
    expect(menu?.querySelector('[data-ui="ContextMenu.Trigger"]')?.textContent).toBe("bot:1");
    expect(menu?.querySelector('[data-ui="ContextMenu.Preview"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("offers read state, pin, notifications, move and archive last for a bot", () => {
    const { items, find, root } = render({
      unread: true,
      pinned: false,
      notifyOnFinish: true,
      sectionId: "s1",
    });
    expect(entries(items)).toEqual([
      ["Mark as Read", "checkmark.message.fill", null],
      ["Pin", "pin", null],
      ["Silence notifications", "bell.slash", null],
      ["Move to", "folder", null],
      ["Archive", "eye.slash", "destructive"],
    ]);
    // Menu items keep their titles; only the swipe buttons are icon-only.
    for (const button of items.querySelectorAll<HTMLElement>("button")) {
      expect(button.dataset.modifiers ?? "[]").toBe("[]");
    }
    expect(entries(find('[data-ui="Menu"]')!)).toEqual([
      ["Work", "true", null],
      ["Home", "false", null],
      ["Unassigned", "false", null],
      ["New section", "folder.badge.plus", null],
      ["Rename section", "pencil", null],
    ]);
    act(() => root.unmount());
  });

  it("offers a group's actions without notifications or renaming outside a section", () => {
    const { items, find, root } = render({ key: "group:1", unread: false, pinned: true });
    expect(entries(items).map(([label]) => label)).toEqual([
      "Mark as Unread",
      "Unpin",
      "Move to",
      "Archive",
    ]);
    expect(entries(find('[data-ui="Menu"]')!)).toEqual([
      ["Work", "false", null],
      ["Home", "false", null],
      ["Unassigned", "true", null],
      ["New section", "folder.badge.plus", null],
    ]);
    act(() => root.unmount());
  });

  it("runs menu items through the swipe and organize paths", () => {
    const { press, onAction, onOrganize, onEditSection, root } = render({
      unread: false,
      pinned: false,
      notifyOnFinish: false,
      sectionId: "s1",
    });
    press("Mark as Unread");
    press("Pin");
    press("Resume notifications");
    press("Work");
    press("Home");
    press("Unassigned");
    press("New section");
    press("Rename section");
    press("Archive");
    expect(onAction.mock.calls).toEqual([["unread"], ["pin"], ["archive"]]);
    // Choosing the current section again changes nothing.
    expect(onOrganize.mock.calls).toEqual([
      [{ notifyOnFinish: true }],
      [{ sectionId: "s2" }],
      [{ sectionId: null }],
    ]);
    expect(onEditSection.mock.calls).toEqual([["create"], ["rename"]]);
    act(() => root.unmount());
  });

  it("previews the chat's last message as the server sent it, or says there are none", () => {
    // The server already stores the preview as plain text; literal marks in it are content.
    const message = "Run `pnpm test`, then <b>ship</b> *now*";
    const withMessage = render({}, { title: "Ada", message: ` ${message}\n`, avatar: <i /> });
    const preview = withMessage.find('[data-ui="ContextMenu.Preview"]')!;
    expect(
      Array.from(preview.querySelectorAll('[data-ui="Text"]')).map((text) => text.textContent),
    ).toEqual(["Ada", message]);
    act(() => withMessage.root.unmount());
    const empty = render({}, { title: "Ada", message: "", avatar: <i /> });
    expect(empty.find('[data-ui="ContextMenu.Preview"]')!.textContent).toBe("AdaNo messages yet");
    act(() => empty.root.unmount());
  });
});

describe("inbox row long press", () => {
  const source = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8").replace(/\s+/g, "");

  it("leaves long press to the system menu on iOS rows and keeps the sheet elsewhere", () => {
    for (const kind of ["bot", "group"]) {
      const name = kind === "bot" ? "organizeBot" : "organizeGroup";
      expect(source).toContain(`onLongPress={!SWIPE_ROWS?${name}:undefined}`);
    }
  });
});

describe("cross-space organize", () => {
  const source = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8");
  const handler = source.slice(
    source.indexOf("  const organize = useCallback("),
    source.indexOf("  const organizeBot = useCallback("),
  );

  function setup(cached: boolean) {
    const chat = { id: "bot-other", spaceId: "space-other" };
    const space = { id: chat.spaceId, bots: [chat], groups: [], botSections: [] };
    const scope = {
      useCallback: (callback: unknown) => callback,
      organizeRequestId: { current: 0 },
      currentSessionGeneration: () => 1,
      currentApiBase: () => "",
      me: { spaceId: "space-current" },
      bots: [],
      groups: [],
      botSections: [],
      spaces: cached ? [space] : [],
      captureApiRequestContext: vi.fn(async () => ({ headers: { authorization: "Bearer fake" } })),
      rpc: vi.fn(async () => ({ current: space })),
      setOrganizeTarget: vi.fn(),
      // A background poll must not delay showing an already available chat.
      loadBots: vi.fn(() => new Promise(() => {})),
      Alert: { alert: vi.fn() },
      errorText: (_error: unknown, fallback: string) => fallback,
      t: (text: string) => text,
    };
    const compiled = ts.transpileModule(`${handler}\nreturn organize;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const organize = new Function(...Object.keys(scope), compiled)(...Object.values(scope)) as (
      kind: string,
      chat: { id: string; spaceId: string },
    ) => Promise<void>;
    return { ...scope, organize, chat, space };
  }

  it("opens immediately from the other space's cached data", async () => {
    const h = setup(true);
    const done = h.organize("bot", h.chat);
    expect(h.setOrganizeTarget).toHaveBeenCalledWith({
      kind: "bot",
      id: h.chat.id,
      spaceId: h.chat.spaceId,
      chat: h.chat,
      sections: [],
    });
    expect(h.rpc).not.toHaveBeenCalled();
    await done;
  });

  it("fetches missing data in the target space independently of inbox polling", async () => {
    const h = setup(false);
    await h.organize("bot", h.chat);
    expect(h.rpc).toHaveBeenCalledWith("spaces/list", undefined, {
      requestContext: {
        headers: { authorization: "Bearer fake", "x-rakazo-space-id": h.chat.spaceId },
      },
      skipSpaceAuthRecovery: true,
    });
    expect(h.setOrganizeTarget).toHaveBeenCalledWith(expect.objectContaining({ chat: h.chat }));
  });

  it("ignores a fallback response after the organize target is closed", async () => {
    const h = setup(false);
    let finish!: (value: { current: typeof h.space }) => void;
    h.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const done = h.organize("bot", h.chat);
    await Promise.resolve();
    h.organizeRequestId.current += 1;
    finish({ current: h.space });
    await done;
    expect(h.setOrganizeTarget).not.toHaveBeenCalled();
  });
});

describe("inbox swipe handlers", () => {
  const source = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8");
  const handlerSource = [
    source.slice(
      source.indexOf("/** Sends a request about a chat to that chat's space"),
      source.indexOf("export default function HomeRoute()"),
    ),
    source.slice(
      source.indexOf("  // One path for the long-press sheet and the swipe actions."),
      source.indexOf("  const botAction = useCallback("),
    ),
  ].join("\n");

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
        chat: { id: string; spaceId?: string },
        action: InboxRowAction,
      ) => Promise<void>;
      updateChat: (
        kind: "bot" | "group",
        chat: { id: string; spaceId?: string },
        update: { pinned?: boolean },
      ) => Promise<void>;
    };
    return { ...scope, state, runRowAction: run.runRowAction, updateChat: run.updateChat };
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

  it("archives a chat from another space in that space", async () => {
    const h = handlers(async () => ({ ok: true }));
    await h.runRowAction("group", { id: "x", spaceId: "space-b" }, "archive");
    expect(h.rpc.mock.calls[0]?.[2]).toMatchObject({
      requestContext: { headers: { "x-rakazo-space-id": "space-b" } },
    });
  });

  it("marks a chat from another space read in that space", async () => {
    const h = handlers(async () => ({ ok: true }));
    await h.runRowAction("bot", { id: "x", spaceId: "space-b" }, "read");
    expect(h.rpc.mock.calls[0]?.[2]).toMatchObject({
      requestContext: { headers: { "x-rakazo-space-id": "space-b" } },
    });
  });

  it("updates a chat from another space in that space without switching", async () => {
    const h = handlers(async () => ({ ok: true }));
    await h.updateChat("bot", { id: "x", spaceId: "space-b" }, { pinned: false });
    expect(h.rpc.mock.calls).toEqual([
      [
        "bots/update",
        { botId: "x", pinned: false },
        {
          requestContext: {
            apiBase: "",
            headers: { authorization: "Bearer token", "x-rakazo-space-id": "space-b" },
            sessionGeneration: 1,
          },
          skipSpaceAuthRecovery: true,
        },
      ],
    ]);
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
