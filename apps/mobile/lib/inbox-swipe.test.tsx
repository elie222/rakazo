// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
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
  const ContextMenu = Object.assign(
    ({ children, modifiers }: { children?: ReactNode; modifiers?: unknown[] }) => (
      <div data-ui="ContextMenu" data-modifiers={JSON.stringify(modifiers ?? [])}>
        {children}
      </div>
    ),
    {
      Trigger: box("ContextMenu.Trigger"),
      Preview: box("ContextMenu.Preview"),
      Items: box("ContextMenu.Items"),
    },
  );
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
    shapes: {
      roundedRectangle: (value: unknown) => ({ shape: "roundedRectangle", value }),
      rectangle: () => ({ shape: "rectangle" }),
    },
    ...Object.fromEntries(
      [
        "background",
        "contentShape",
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
      // Not destructive: SwiftUI would remove the row at the tap, and a failed archive left a gap.
      ["Archive", "eye.slash", null],
      ["Unpin", "pin.slash", null],
    ]);
    expect(JSON.parse(buttons[0]!.dataset.modifiers!)).toContainEqual({
      name: "tint",
      value: { semantic: ["systemBlue"] },
    });
    expect(JSON.parse(buttons[1]!.dataset.modifiers!)).toContainEqual({
      name: "tint",
      value: { semantic: ["systemRed"] },
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

  it("gives the chat row context menu a rectangular hit area", () => {
    const { find, root } = render();
    const menu = find('[data-ui="SwipeActions"] > [data-ui="ContextMenu"]');
    expect(JSON.parse(menu?.dataset.modifiers ?? "[]")).toEqual([
      { name: "contentShape", value: { shape: "rectangle" } },
    ]);
    act(() => root.unmount());
  });

  it("offers read state, pin, notifications, move, then archive and delete last for a bot", () => {
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
      ["Archive", "eye.slash", null],
      ["Delete…", "trash", "destructive"],
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
      "Delete…",
    ]);
    expect(items.querySelector('[data-label="Archive"]')?.getAttribute("data-role")).toBeNull();
    expect(items.querySelector('[data-label="Delete…"]')?.getAttribute("data-role")).toBe(
      "destructive",
    );
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
    press("Delete…");
    expect(onAction.mock.calls).toEqual([["unread"], ["pin"], ["archive"], ["delete"]]);
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
