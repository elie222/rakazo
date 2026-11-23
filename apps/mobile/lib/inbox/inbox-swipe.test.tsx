// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenSwipe } from "../../components/inbox/inbox-swipe-context";
import { InboxSwipeContext } from "../../components/inbox/inbox-swipe-context";
import type { InboxSwipeRowProps } from "../../components/inbox/inbox-swipe-row";
import { InboxSwipeRow } from "../../components/inbox/inbox-swipe-row.ios";
import { NativeListRowContext } from "../../components/native/native-list-row";
// Activates the language the row actions are translated into, as the app does at startup.
import "../i18n/i18n";
import type { MobileBotSection } from "../api/mobile-types";
import type { InboxRowAction } from "./inbox-swipe";
import {
  applyUnreadOverrides,
  chatTarget,
  createLatestQueue,
  inboxRowActionList,
  inboxRowActions,
  unreadOverrideKey,
} from "./inbox-swipe";

const swipe = vi.hoisted(() => ({
  touch: () => {},
  start: () => {},
  update: (_event: { translationX: number }) => {},
  end: (_event: { translationX: number }, _success: boolean) => {},
  measure: (_event: { nativeEvent: { layout: { width: number } } }) => {},
  foreground: () => ({ transform: [{ translateX: 0 }] }),
  actionStyles: [] as Array<
    () => {
      opacity: number;
      transform: Array<{ translateX: number } | { scale: number }>;
    }
  >,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "27.1" },
  I18nManager: { isRTL: false },
  StyleSheet: { absoluteFill: {}, create: (styles: object) => styles },
  Pressable: () => null,
  PlatformColor: (name: string) => ({ semantic: [name] }),
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  View: ({
    children,
    style,
    onLayout,
  }: {
    children: ReactNode;
    style?: { width?: number };
    onLayout?: typeof swipe.measure;
  }) => {
    if (onLayout) swipe.measure = onLayout;
    return <div data-width={style?.width}>{children}</div>;
  },
}));
vi.mock("../native/native", () => ({
  native: { page: "page", fill: "fill" },
  useMobileTokens: () => ({ background: "page", muted: "muted", foreground: "ink" }),
  useResolvedAppearance: () => "light",
}));
vi.mock("../native/haptics", () => ({ hapticSelection: vi.fn() }));
vi.mock("react-native-gesture-handler", () => {
  const pan = {
    activeOffsetX: () => pan,
    failOffsetY: () => pan,
    maxPointers: () => pan,
    onBegin: (callback: typeof swipe.touch) => {
      swipe.touch = callback;
      return pan;
    },
    onStart: (callback: typeof swipe.start) => {
      swipe.start = callback;
      return pan;
    },
    onUpdate: (callback: typeof swipe.update) => {
      swipe.update = callback;
      return pan;
    },
    onEnd: (callback: typeof swipe.end) => {
      swipe.end = callback;
      return pan;
    },
  };
  return {
    Gesture: { Pan: () => pan },
    GestureDetector: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children: ReactNode }) => children },
  useSharedValue: <T,>(initial: T) => useState(() => ({ value: initial }))[0],
  cancelAnimation: () => {},
  withTiming: (target: number, _config: undefined, done?: (finished: boolean) => void) => {
    done?.(true);
    return target;
  },
  useAnimatedStyle: (style: typeof swipe.foreground | (typeof swipe.actionStyles)[number]) => {
    const result = style();
    if ("opacity" in result) swipe.actionStyles.push(style as (typeof swipe.actionStyles)[number]);
    else swipe.foreground = style as typeof swipe.foreground;
    return result;
  },
}));
vi.mock("react-native-worklets", () => ({
  scheduleOnUI: (callback: () => void) => callback(),
  scheduleOnRN: <T extends unknown[]>(callback: (...args: T) => void, ...args: T) =>
    callback(...args),
}));
// SwiftUI views render as plain DOM so tests can read the row's structure.
// Tests load the shared module; the list rows are the iOS one.
vi.mock(
  "../../components/native/native-row",
  () => import("../../components/native/native-row.ios"),
);
vi.mock("@expo/ui/swift-ui", () => {
  const box =
    (name: string) =>
    ({ children }: { children?: ReactNode }) => <div data-ui={name}>{children}</div>;
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
    Group: ({
      children,
      modifiers,
    }: {
      children: ReactNode;
      modifiers: Array<{ name: string }>;
    }) => (
      <div
        data-ui="Group"
        data-row-modifiers={modifiers.map((modifier) => modifier.name).join(" ")}
      >
        {children}
      </div>
    ),
    List: box("List"),
    RNHostView: box("RNHostView"),
    VStack: box("VStack"),
    HStack: box("HStack"),
    ZStack: box("ZStack"),
    Circle: box("Circle"),
    Image: ({ systemName }: { systemName: string }) => <span data-symbol={systemName} />,
    Text: ({ children }: { children?: ReactNode }) => <span data-ui="Text">{children}</span>,
    Spacer: () => null,
    Divider: () => <hr />,
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
      children,
    }: {
      label: string;
      systemImage?: string;
      role?: string;
      modifiers?: unknown[];
      onPress: () => void;
      children?: ReactNode;
    }) => (
      <button
        type="button"
        data-ui="Button"
        data-label={label}
        data-image={systemImage}
        data-role={role}
        data-modifiers={JSON.stringify(modifiers ?? [])}
        onClick={onPress}
      >
        {children}
      </button>
    ),
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (name: string) => (value: unknown) => ({ name, value });
  return {
    shapes: {
      circle: () => ({ shape: "circle" }),
      roundedRectangle: (value: unknown) => ({ shape: "roundedRectangle", value }),
      rectangle: () => ({ shape: "rectangle" }),
    },
    ...Object.fromEntries(
      [
        "accessibilityLabel",
        "background",
        "buttonStyle",
        "contentShape",
        "font",
        "foregroundStyle",
        "frame",
        "lineLimit",
        "listRowBackground",
        "listRowInsets",
        "listRowSeparator",
        "listStyle",
        "padding",
        "scrollContentBackground",
        "scrollDisabled",
      ].map((name) => [name, modifier(name)]),
    ),
  };
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  swipe.actionStyles = [];
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
    const { key = "bot:1", ...props } = row;
    const activeSwipe: { current: OpenSwipe | null } = { current: null };
    const onAction = vi.fn<(action: InboxRowAction) => void>();
    const onOrganize = vi.fn<InboxSwipeRowProps["onOrganize"]>();
    const onEditSection = vi.fn<InboxSwipeRowProps["onEditSection"]>();
    const onSnooze = vi.fn<NonNullable<InboxSwipeRowProps["onSnooze"]>>();
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <InboxSwipeContext.Provider value={activeSwipe}>
          <InboxSwipeRow
            rowKey={key}
            sections={sections}
            preview={preview}
            onAction={onAction}
            onOrganize={onOrganize}
            onEditSection={onEditSection}
            snoozed={false}
            onSnooze={onSnooze}
            {...props}
          >
            <span>{key}</span>
          </InboxSwipeRow>
        </InboxSwipeContext.Provider>,
      ),
    );
    const find = (selector: string) => container.querySelector<HTMLElement>(selector);
    const items = find('[data-ui="ContextMenu.Items"]')!;
    const press = (label: string) =>
      act(() => items.querySelector<HTMLElement>(`[data-label="${label}"]`)!.click());
    return {
      container,
      find,
      items,
      press,
      activeSwipe,
      onAction,
      onOrganize,
      onEditSection,
      onSnooze,
      root,
    };
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

  it("offers native buttons for the revealed actions", () => {
    const { container, onAction, root } = render({ unread: true, pinned: true });
    expect(container.querySelector('[data-ui="ContextMenu.Trigger"] button')).toBeNull();
    act(() => swipe.start());
    const buttons = Array.from(
      container.querySelectorAll<HTMLElement>('[data-ui="ContextMenu.Trigger"] button'),
    );
    expect(
      buttons.map((button) => button.querySelector("[data-symbol]")?.getAttribute("data-symbol")),
    ).toEqual(["checkmark.message.fill", "eye.slash.fill", "pin.slash.fill"]);
    expect(buttons.every((button) => button.querySelector('[data-ui="Circle"]'))).toBe(true);
    act(() => {
      for (const button of buttons) button.click();
    });
    expect(onAction.mock.calls).toEqual([["read"], ["archive"], ["unpin"]]);
    act(() => root.unmount());
  });

  it.each([
    [1, "read"],
    [-1, "archive"],
  ] as const)(
    "reveals the action while dragging in direction %s and commits a full swipe on release",
    (direction, action) => {
      const { onAction, root } = render({ unread: true });
      swipe.measure({ nativeEvent: { layout: { width: 300 } } });

      act(() => {
        swipe.start();
        swipe.update({ translationX: direction * 19 });
      });
      const firstAction = swipe.actionStyles[direction === 1 ? 0 : 1]!;
      expect(swipe.foreground().transform).toEqual([{ translateX: direction * 19 }]);
      expect(firstAction().opacity).toBe(0);
      act(() => swipe.update({ translationX: direction * 24 }));
      expect(firstAction().opacity).toBe(1);
      expect(firstAction().transform[1]).toMatchObject({ scale: expect.closeTo(0.32) });
      act(() => swipe.update({ translationX: direction * 45 }));
      expect(firstAction().transform[1]).toMatchObject({ scale: expect.closeTo(0.63) });
      act(() => swipe.update({ translationX: direction * 70 }));
      expect(firstAction().transform[1]).toEqual({ scale: 1 });
      expect(swipe.actionStyles[2]!().opacity).toBe(0);

      act(() => swipe.update({ translationX: direction * 150 }));
      const restingWidth = direction === 1 ? 70 : 130;
      expect(Math.abs(swipe.foreground().transform[0]!.translateX)).toBeGreaterThan(restingWidth);
      expect(firstAction().transform[1]).toEqual({ scale: 1 });
      act(() => swipe.update({ translationX: direction * 190 }));
      expect(firstAction().transform[1]).toEqual({ scale: 1.2 });
      if (direction === -1) expect(swipe.actionStyles[2]!().opacity).toBeLessThan(1);
      act(() => swipe.update({ translationX: direction * 150 }));
      expect(firstAction().transform[1]).toEqual({ scale: 1 });
      if (direction === -1) expect(swipe.actionStyles[2]!().opacity).toBe(1);
      act(() => swipe.update({ translationX: direction * 190 }));
      expect(onAction).not.toHaveBeenCalled();
      act(() => swipe.end({ translationX: direction * 190 }, false));
      expect(onAction).not.toHaveBeenCalled();
      expect(swipe.foreground().transform).toEqual([{ translateX: 0 }]);

      act(() => {
        swipe.start();
        swipe.update({ translationX: direction * 190 });
        swipe.end({ translationX: direction * 190 }, true);
      });
      expect(onAction).toHaveBeenCalledExactlyOnceWith(action);
      act(() => root.unmount());
    },
  );

  it("stays closed when scrolling dismisses the row mid-swipe", () => {
    const { container, activeSwipe, onAction, root } = render();
    act(() => {
      swipe.start();
      swipe.update({ translationX: -45 });
    });
    expect(container.querySelector('[data-ui="ContextMenu.Trigger"] button')).not.toBeNull();
    act(() => activeSwipe.current?.close());
    act(() => {
      swipe.update({ translationX: -65 });
      swipe.end({ translationX: -65 }, true);
    });
    expect(container.querySelector('[data-ui="ContextMenu.Trigger"] button')).toBeNull();
    expect(swipe.foreground().transform).toEqual([{ translateX: 0 }]);
    expect(onAction).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("dismisses another row's swipe on touch before a pan starts", () => {
    const { activeSwipe, root } = render();
    const close = vi.fn(() => {
      activeSwipe.current = null;
    });
    activeSwipe.current = { id: "another-row", close };
    act(() => swipe.touch());
    expect(close).toHaveBeenCalledOnce();
    expect(activeSwipe.current).toBeNull();
    act(() => root.unmount());
  });

  it("joins the native inbox list as one of its rows, sized to its row", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <NativeListRowContext.Provider
          value={{ modifiers: [{ name: "listRowInsets" } as never], width: 300 }}
        >
          <InboxSwipeRow
            rowKey="bot:1"
            sections={sections}
            preview={{ title: "Ada", message: "Hi", avatar: <i /> }}
            onAction={vi.fn()}
            onOrganize={vi.fn()}
            onEditSection={vi.fn()}
          >
            <span>Ada</span>
          </InboxSwipeRow>
        </NativeListRowContext.Provider>,
      ),
    );
    // No list of its own: the row takes the list's row modifiers.
    expect(container.querySelector('[data-ui="List"]')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-ui="Group"]')?.dataset.rowModifiers).toBe(
      "listRowInsets",
    );
    // Hosted content takes the width the list lays the row out at.
    const trigger = container.querySelector('[data-ui="ContextMenu.Trigger"]');
    expect(trigger?.querySelector("[data-width]")?.getAttribute("data-width")).toBe("300");
    act(() => root.unmount());
  });

  it("opens the system context menu with a preview on the same list row as the swipe actions", () => {
    const { find, root } = render();
    const menu = find('[data-ui="Group"] > [data-ui="ContextMenu"]');
    expect(menu?.querySelector('[data-ui="ContextMenu.Trigger"]')?.textContent).toBe("bot:1");
    expect(menu?.querySelector('[data-ui="ContextMenu.Preview"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("gives the chat row context menu a rectangular hit area", () => {
    const { find, root } = render();
    const menu = find('[data-ui="Group"] > [data-ui="ContextMenu"]');
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
      ["Snooze", "moon.zzz", null],
      ["Move to", "folder", null],
      ["Archive", "eye.slash", null],
      ["Delete…", "trash", "destructive"],
    ]);
    // Menu items keep their titles; only the swipe buttons are icon-only.
    for (const button of items.querySelectorAll<HTMLElement>("button")) {
      expect(button.dataset.modifiers ?? "[]").toBe("[]");
    }
    expect(entries(find('[data-ui="Menu"][data-label="Move to"]')!)).toEqual([
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
      "Snooze",
      "Move to",
      "Archive",
      "Delete…",
    ]);
    expect(items.querySelector('[data-label="Archive"]')?.getAttribute("data-role")).toBeNull();
    expect(items.querySelector('[data-label="Delete…"]')?.getAttribute("data-role")).toBe(
      "destructive",
    );
    expect(entries(find('[data-ui="Menu"][data-label="Move to"]')!)).toEqual([
      ["Work", "false", null],
      ["Home", "false", null],
      ["Unassigned", "true", null],
      ["New section", "folder.badge.plus", null],
    ]);
    act(() => root.unmount());
  });

  it("snoozes until a preset, or offers Unsnooze while snoozed", () => {
    const { find, press, onSnooze, root } = render();
    expect(entries(find('[data-ui="Menu"][data-label="Snooze"]')!).map(([label]) => label)).toEqual(
      ["1 hour", "3 hours", "Tomorrow", "Next week"],
    );
    const before = Date.now();
    press("1 hour");
    const until = Date.parse(onSnooze.mock.calls[0]![0]!);
    expect(until - before).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
    expect(until - before).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
    act(() => root.unmount());

    const snoozed = render({ snoozed: true });
    expect(snoozed.find('[data-ui="Menu"][data-label="Snooze"]')).toBeNull();
    snoozed.press("Unsnooze");
    expect(snoozed.onSnooze).toHaveBeenCalledWith(null);
    act(() => snoozed.root.unmount());
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
