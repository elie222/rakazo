// @vitest-environment jsdom

import type { CSSProperties, ReactElement, ReactNode } from "react";
import { act, cloneElement, useEffect, useMemo, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useInboxRenderItem } from "../components/inbox-render-item";
import { BotRow } from "../components/inbox-rows";
import type { NativeRowMenu } from "../components/native-row";
import { askForModelBeforeFirstBot, createInboxBot } from "./create-inbox-bot";
import { scheduleFocusPrompt } from "./focus-prompt";
import { formatThreadTime } from "./inbox";
import { onInboxChanged } from "./inbox-changes";
import { retainInboxValue } from "./inbox-retention";
import type { InboxItem, InboxSpace } from "./inbox-spaces";
import { inboxItemKey, spaceInboxItems } from "./inbox-spaces";
import type { MobileBot, MobileGroup } from "./mobile-types";
import { useCollapsedSections } from "./use-collapsed-sections";
import { useInboxDay } from "./use-inbox-day";
import { usePublishSearchInbox } from "./use-publish-search-inbox";

type MenuProps = {
  actions: { id: string; title: string; attributes?: { disabled?: boolean } }[];
  onPressAction: (event: { nativeEvent: { event: string } }) => void;
  children?: ReactNode;
};
const ui = vi.hoisted(() => ({
  focused: true,
  appStateListener: undefined as ((state: string) => void) | undefined,
  previews: 0,
  push: vi.fn(),
  menus: [] as MenuProps[],
  rowMenus: [] as NativeRowMenu[],
  a11yActions: new Map<string, (event: { nativeEvent: { actionName: string } }) => void>(),
  swipeRows: [] as string[],
  swipeMuted: [] as Array<boolean | undefined>,
  avatars: [] as string[],
  chevronStarts: [] as number[],
  chevronTargets: [] as number[],
  rpc: vi.fn(),
  alert: vi.fn(),
  spaceId: "space-a",
  spaceSeq: 0,
  sameSession: true,
  setSearchInbox: vi.fn(),
  addToSearchInbox: vi.fn(),
  searchInboxSession: vi.fn(),
  hapticSuccess: vi.fn(),
  loadCollapsedSections: vi.fn(),
  saveCollapsedSections: vi.fn(),
}));

vi.mock("react-native", () => {
  const flatten = (style: unknown): CSSProperties =>
    Object.assign({}, ...[style].flat(Number.POSITIVE_INFINITY).filter(Boolean));
  return {
    Alert: { alert: ui.alert },
    AppState: {
      addEventListener: (_event: string, listener: (state: string) => void) => {
        ui.appStateListener = listener;
        return { remove: () => (ui.appStateListener = undefined) };
      },
    },
    Platform: { OS: "ios" },
    PlatformColor: (name: string) => name,
    StyleSheet: { create: <T,>(styles: T) => styles },
    useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
    View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Pressable: ({
      children,
      accessibilityLabel,
      accessibilityState,
      accessibilityValue,
      onPress,
      onLongPress,
      accessibilityActions,
      onAccessibilityAction,
      style,
    }: {
      children?: ReactNode;
      accessibilityActions?: Array<{ name: string }>;
      onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
      accessibilityLabel?: string;
      accessibilityState?: { expanded?: boolean };
      accessibilityValue?: { text?: string };
      onPress?: () => void;
      onLongPress?: () => void;
      style?: unknown;
    }) => (
      <button
        type="button"
        aria-label={accessibilityLabel}
        aria-expanded={accessibilityState?.expanded}
        data-value={accessibilityValue?.text}
        data-long-press={onLongPress ? "true" : undefined}
        data-actions={accessibilityActions?.map((action) => action.name).join(" ")}
        ref={() => {
          if (accessibilityLabel && onAccessibilityAction)
            ui.a11yActions.set(accessibilityLabel, onAccessibilityAction);
        }}
        data-min-height={
          flatten(typeof style === "function" ? style({ pressed: false }) : style).minHeight
        }
        onClick={onPress}
      >
        {children}
      </button>
    ),
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  Easing: { out: (easing: unknown) => easing, cubic: "cubic" },
  ReduceMotion: { System: "system" },
  useAnimatedStyle: (style: () => unknown) => style(),
  useSharedValue: (value: number) => {
    const [shared] = useState(() => {
      ui.chevronStarts.push(value);
      return { value };
    });
    return shared;
  },
  withTiming: (value: number) => {
    ui.chevronTargets.push(value);
    return value;
  },
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: MenuProps) => {
    ui.menus.push(props);
    return props.children;
  },
}));
// On iOS a heading's menu is the native list row's long-press menu.
vi.mock("../components/native-row", () => ({
  NativeRow: ({ menu, children }: { menu?: NativeRowMenu; children: ReactNode }) => {
    if (menu) ui.rowMenus.push(menu);
    return children;
  },
}));
vi.mock("expo-router", () => {
  const router = { push: ui.push };
  return {
    router,
    useRouter: () => router,
    // The inbox's focus: expo-router reruns the effect when focus returns.
    useFocusEffect: (effect: () => (() => void) | undefined) => {
      const focused = ui.focused;
      useEffect(() => (focused ? effect() : undefined), [effect, focused]);
    },
  };
});
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: ui.rpc,
  captureApiRequestContext: async (spaceId: string | null = "space-selected") => ({
    headers: { "x-rakazo-space-id": spaceId },
  }),
  selectedSpaceId: () => ui.spaceId,
  spaceSelectionSeq: () => ui.spaceSeq,
}));
vi.mock("./haptics", () => ({ hapticSuccess: ui.hapticSuccess }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => useMemo(factory, [factory]),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
// The row's avatar freezes while the row is scrolled out of view.
vi.mock("./avatar-life", () => ({
  AvatarRow: ({ id, children }: { id: string; children: ReactNode }) => (
    <i data-row={id}>{children}</i>
  ),
}));
// Counts row executions: every bot row render builds its preview once.
vi.mock("./preview", () => ({
  previewSnippet: (text: string) => {
    ui.previews++;
    return text;
  },
}));
vi.mock("./collapsed-sections", () => ({
  loadCollapsedSections: ui.loadCollapsedSections,
  saveCollapsedSections: ui.saveCollapsedSections,
}));
vi.mock("./search-inbox", () => ({
  setSearchInbox: ui.setSearchInbox,
  addToSearchInbox: ui.addToSearchInbox,
  searchInboxSession: ui.searchInboxSession,
  isSearchInboxSession: (askedIn: { generation: number; apiBase: string }) => {
    const current = ui.searchInboxSession();
    return (
      ui.sameSession &&
      askedIn.generation === current.generation &&
      askedIn.apiBase === current.apiBase
    );
  },
}));
vi.mock("./focus-prompt", () => ({ allowFocusPrompt: vi.fn(), scheduleFocusPrompt: vi.fn() }));
vi.mock("../components/bot-avatar", () => ({
  BotAvatar: ({
    identity,
    muted,
    motion,
  }: {
    identity: string;
    muted?: boolean;
    motion?: string;
  }) => {
    ui.avatars.push(identity);
    return <b data-identity={identity} data-muted={String(Boolean(muted))} data-motion={motion} />;
  },
  MutedBadge: () => <s data-muted-badge />,
}));
vi.mock("../components/group-avatar", () => ({ GroupAvatar: () => null }));
// Rows in the current space carry the iOS swipe host and its long-press menu.
vi.mock("../components/inbox-swipe-row", () => ({
  InboxSwipeRow: ({
    rowKey,
    sections,
    muted,
    children,
  }: {
    rowKey: string;
    sections: { id: string }[];
    muted?: boolean;
    children: ReactElement;
  }) => {
    ui.swipeRows.push([rowKey, ...sections.map((section) => section.id)].join(" "));
    ui.swipeMuted.push(muted);
    return children;
  },
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));

const action = vi.fn();
const callbacks = {
  appearance: "light" as const,
  botAction: action,
  chooseInboxSpace: action,
  confirmDeleteSpace: action,
  createBotInSpace: action,
  deleteSection: action,
  editSectionFromMenu: action,
  groupAction: action,
  openBot: action,
  openGroup: action,
  organizeBot: action,
  organizeFromMenu: action,
  organizeGroup: action,
  sharing: false,
  snoozeChat: action,
  spaces: [],
  spaceBusy: false,
  spaceRecoveryId: null,
  toggleCollapsed: action,
};

let onRenderItem: ((renderItem: unknown) => void) | undefined;
function List({
  items,
  spaceId = "space-1",
  day = 0,
  options,
}: {
  items: InboxItem[];
  spaceId?: string;
  day?: number;
  options?: Partial<Parameters<typeof useInboxRenderItem>[0]>;
}) {
  const renderItem = useInboxRenderItem({ now: 0, ...callbacks, ...options, day, spaceId });
  onRenderItem?.(renderItem);
  // Keyed like the inbox's FlatList.
  return items.map((item) => cloneElement(renderItem({ item }), { key: inboxItemKey(item) }));
}

function DayList({ items }: { items: InboxItem[] }) {
  return <List items={items} day={useInboxDay()} />;
}

let container: HTMLDivElement;
let root: Root;
const render = (element: ReactNode) => act(() => root.render(element));
const rowLabels = () =>
  Array.from(container.querySelectorAll("button"), (button) => button.getAttribute("aria-label"));

beforeEach(() => {
  ui.searchInboxSession.mockReset().mockReturnValue({ generation: 7, apiBase: "http://api.test" });
  ui.sameSession = true;
  ui.hapticSuccess.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(ui, {
    focused: true,
    previews: 0,
    menus: [],
    rowMenus: [],
    swipeRows: [],
    swipeMuted: [],
    avatars: [],
    chevronStarts: [],
    chevronTargets: [],
  });
  onRenderItem = undefined;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

function measure(retain: boolean) {
  let previousRenderItem: unknown;
  onRenderItem = (renderItem) => {
    // Parent renders must not hand the list a new renderer, or every row would render.
    if (previousRenderItem) expect(renderItem).toBe(previousRenderItem);
    previousRenderItem = renderItem;
  };
  const items = (bots: MobileBot[]) => bots.map((bot) => ({ type: "bot" as const, bot }));
  let bots = Array.from({ length: 30 }, (_, index) => ({
    id: `bot-${index}`,
    name: `Helper ${index}`,
    spaceId: "space-1",
    preview: "",
    color: "gray",
    status: "idle",
    notifyOnFinish: true,
    unread: false,
  })) as MobileBot[];
  ui.previews = 0;
  render(<List items={items(bots)} />);
  const mount = ui.previews;
  for (let poll = 0; poll < 12; poll++) {
    const fetched = structuredClone(bots);
    bots = retain ? retainInboxValue(bots, fetched) : fetched;
    // Force parent rendering too, as with activity/refresh state changes.
    render(<List items={items(bots)} />);
  }
  const idle = ui.previews - mount;
  const fetched = structuredClone(bots);
  fetched[0]!.status = "running";
  fetched[0]!.unread = true;
  bots = retain ? retainInboxValue(bots, fetched) : fetched;
  render(<List items={items(bots)} />);
  act(() => root.unmount());
  root = createRoot(container);
  return { mount, idle, changed: ui.previews - mount - idle };
}

it("skips unchanged inbox rows for 12 idle polls and renders the changed bot", () => {
  // Without retained poll results every row renders on every poll.
  expect(measure(false)).toEqual({ mount: 30, idle: 360, changed: 30 });
  expect(measure(true)).toEqual({ mount: 30, idle: 0, changed: 1 });
});

it.each(["midnight", "focus", "foreground"])(
  "refreshes unchanged bot and group timestamps on %s",
  (trigger) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 10, 23, 59));
    const today = new Date(2026, 9, 10, 12, 30).toISOString();
    const sixDaysAgo = new Date(2026, 9, 4, 12, 30).toISOString();
    // Keep the response and every row object identical throughout the date change.
    const items = [today, sixDaysAgo].flatMap((updatedAt): InboxItem[] => [
      { type: "bot", bot: { id: updatedAt, name: "Helper", preview: "", updatedAt } as MobileBot },
      {
        type: "group",
        group: { id: updatedAt, name: "Team", preview: "", members: [], updatedAt },
      } as unknown as InboxItem,
    ]);
    const labels = (todayTime: string, weekTime: string) => [
      `Helper, ${todayTime}, No messages yet`,
      `Team, ${todayTime}`,
      `Helper, ${weekTime}, No messages yet`,
      `Team, ${weekTime}`,
    ];
    try {
      render(<DayList items={items} />);
      const weekday = formatThreadTime(sixDaysAgo, new Date(2026, 9, 10));
      expect(rowLabels()).toEqual(labels("12:30", weekday));
      if (trigger === "focus") {
        ui.focused = false;
        render(<DayList items={items} />);
        expect(ui.appStateListener).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      }
      if (trigger === "midnight") {
        act(() => vi.advanceTimersByTime(60_000));
      } else {
        // Suspended native timers need not fire before the app returns.
        vi.setSystemTime(new Date(2026, 9, 11, 8));
        act(() => {
          if (trigger === "foreground") ui.appStateListener?.("active");
          else {
            ui.focused = true;
            root.render(<DayList items={items} />);
          }
        });
      }
      expect(rowLabels()).toEqual(labels(formatThreadTime(today), formatThreadTime(sixDaysAgo)));
      expect(formatThreadTime(today)).not.toBe("12:30");
      expect(formatThreadTime(sixDaysAgo)).not.toBe(weekday);
      expect(vi.getTimerCount()).toBe(1);
      act(() => root.unmount());
      expect(ui.appStateListener).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      root = createRoot(container);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("renders saved bot rows without a notification setting", () => {
  // Inboxes saved before notification settings were kept have bots without them.
  const bots = [
    { id: "bot-a", name: "Alpha", preview: "", notifyOnFinish: true },
    { id: "bot-b", name: "Beta", preview: "" },
    { id: "bot-c", name: "Gamma", preview: "", notifyOnFinish: false },
  ] as MobileBot[];
  render(
    bots.map((bot) => (
      <BotRow
        key={bot.id}
        bot={bot}
        day={0}
        now={0}
        onPress={action}
        sections={[]}
        onOrganize={action}
        onEditSection={action}
        onSnooze={action}
      />
    )),
  );
  expect(rowLabels()).toEqual([
    "Alpha, No messages yet",
    "Beta, No messages yet",
    "Gamma, notifications silenced, No messages yet",
  ]);
  expect(Array.from(container.querySelectorAll("button"), (row) => row.textContent)).toEqual([
    "AlphaNo messages yet",
    "BetaNo messages yet",
    "GammaNo messages yet",
  ]);
  const avatars = Array.from(container.querySelectorAll("i[data-row] > b"));
  expect(avatars.map((avatar) => avatar.parentElement?.dataset.row)).toEqual([
    "bot-a",
    "bot-b",
    "bot-c",
  ]);
  expect(avatars.map((avatar) => (avatar as HTMLElement).dataset.muted)).toEqual([
    "false",
    "false",
    "true",
  ]);
  expect(avatars.every((avatar) => (avatar as HTMLElement).dataset.motion === "lazy")).toBe(true);
});

it("says working only while the bot works, and shows nothing beside the time", () => {
  const bots = ["running", "waiting_takeover", "waiting_input", "idle"].map(
    (status) =>
      ({ id: status, name: "Helper", preview: "Hi", status, color: "#8B5CF6" }) as MobileBot,
  );
  render(
    bots.map((bot) => (
      <BotRow
        key={bot.id}
        bot={bot}
        day={0}
        now={0}
        onPress={action}
        sections={[]}
        onOrganize={action}
        onEditSection={action}
        onSnooze={action}
      />
    )),
  );
  // A "Needs you" computer card or an ask card is the state; the row must not claim work.
  expect(rowLabels()).toEqual(["Helper, Working…, Hi", "Helper, Hi", "Helper, Hi", "Helper, Hi"]);
  // The avatar's motion and corner dot are the only working sign; the time stands alone.
  expect(Array.from(container.querySelectorAll("button"), (row) => row.textContent)).toEqual([
    "HelperHi",
    "HelperHi",
    "HelperHi",
    "HelperHi",
  ]);
});

it("marks a ghost bot waiting on you like an unread chat", () => {
  const bot = {
    id: "asks",
    name: "Helper",
    preview: "Hi",
    status: "waiting_input",
    avatarSet: "rakazo",
    color: "#8B5CF6",
  } as MobileBot;
  render(
    <BotRow
      bot={bot}
      day={0}
      now={0}
      onPress={action}
      sections={[]}
      onOrganize={action}
      onEditSection={action}
      onSnooze={action}
    />,
  );
  expect(rowLabels()).toEqual(["Helper, Needs attention, Hi"]);
});

it("ties the pinned tiles' avatars to the pinned row, so they freeze when it scrolls away", () => {
  const bot = { id: "bot-p", name: "Pinned", preview: "", pinned: true } as MobileBot;
  render(<List items={[{ type: "pinned", chats: [{ kind: "bot", bot }] }]} />);
  expect(container.querySelector('[data-row="pinned"] b[data-identity="bot-p"]')).not.toBeNull();
});

it("marks a muted pinned group as a muted pinned bot is marked", () => {
  const bot = { id: "bot-p", name: "Scout", preview: "", pinned: true, notifyOnFinish: false };
  const group = {
    id: "group-p",
    name: "Crew",
    preview: "",
    pinned: true,
    muted: true,
    members: [],
  };
  render(
    <List
      items={[
        {
          type: "pinned",
          chats: [
            { kind: "bot", bot: bot as MobileBot },
            { kind: "group", group: group as unknown as MobileGroup },
          ],
        },
      ]}
    />,
  );
  expect(rowLabels()).toEqual(["Scout, notifications silenced", "Crew, notifications silenced"]);
  expect(container.querySelector('b[data-identity="bot-p"]')?.getAttribute("data-muted")).toBe(
    "true",
  );
  expect(container.querySelectorAll("[data-muted-badge]")).toHaveLength(1);
});

it("collapses a section from its heading and keeps the choice for the account", async () => {
  ui.loadCollapsedSections.mockReset().mockResolvedValue(null);
  ui.saveCollapsedSections.mockReset();
  function SectionList({ spaces, me }: { spaces: InboxSpace[]; me: { userId: string } }) {
    const { collapsed, toggleCollapsed, loaded } = useCollapsedSections(me.userId);
    const renderItem = useInboxRenderItem({
      ...callbacks,
      toggleCollapsed,
      day: 0,
      now: 0,
      spaceId,
    });
    // The inbox waits for the saved choice, so a collapsed section never draws open first.
    if (!loaded) return null;
    return spaceInboxItems(spaces, collapsed, spaceId).map((item) =>
      cloneElement(renderItem({ item }), { key: inboxItemKey(item) }),
    );
  }
  const spaceId = "space-1";
  const work = {
    id: "work",
    name: "Work",
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const spaces = [
    {
      id: spaceId,
      name: "Personal",
      isDefault: true,
      hasContent: true,
      botSections: [work],
      groups: [],
      bots: [
        { id: "bot-a", name: "Alpha", preview: "", sectionId: "work" },
        { id: "bot-b", name: "Beta", preview: "", sectionId: "work" },
        { id: "bot-c", name: "Gamma", preview: "", sectionId: null },
      ],
    },
  ] as unknown as InboxSpace[];
  const userOne = { userId: "user-1" };
  const heading = () => container.querySelector("button")!;
  const names = () =>
    Array.from(container.querySelectorAll("b[data-identity]"), (row) =>
      row.getAttribute("data-identity"),
    );
  await act(async () => root.render(<SectionList spaces={spaces} me={userOne} />));
  expect(ui.loadCollapsedSections).toHaveBeenCalledTimes(1);
  expect(heading().getAttribute("aria-label")).toBe("Collapse Work");
  expect(heading().getAttribute("aria-expanded")).toBe("true");
  expect(heading().hasAttribute("data-value")).toBe(false);
  expect(heading().textContent).toBe("Work");
  // Every heading is a full tap target, with or without the section "…" menu beside it.
  expect(heading().dataset.minHeight).toBe("44");
  expect(names()).toEqual(["bot-a", "bot-b", "bot-c"]);

  ui.chevronTargets = [];
  act(() => heading().click());
  expect(heading().getAttribute("aria-label")).toBe("Expand Work");
  expect(heading().getAttribute("aria-expanded")).toBe("false");
  expect(heading().getAttribute("data-value")).toBe("2");
  expect(heading().textContent).toBe("Work2");
  // The chevron turns back to point right.
  expect(ui.chevronTargets).toEqual([0]);
  expect(names()).toEqual(["bot-c"]);
  expect(ui.saveCollapsedSections).toHaveBeenLastCalledWith(
    "user-1",
    new Set(["space-1:section:work"]),
  );

  act(() => heading().click());
  expect(heading().getAttribute("aria-label")).toBe("Collapse Work");
  expect(names()).toEqual(["bot-a", "bot-b", "bot-c"]);
  expect(ui.saveCollapsedSections).toHaveBeenLastCalledWith("user-1", new Set());

  // Quick taps save once per committed state, the final one last.
  act(() => {
    heading().click();
    heading().click();
    heading().click();
  });
  expect(heading().getAttribute("aria-label")).toBe("Expand Work");
  expect(ui.saveCollapsedSections).toHaveBeenLastCalledWith(
    "user-1",
    new Set(["space-1:section:work"]),
  );
  act(() => root.unmount());

  // A relaunch draws the account's collapsed sections folded from the first frame.
  ui.loadCollapsedSections.mockResolvedValueOnce({
    userId: "user-1",
    keys: new Set(["space-1:section:work"]),
  });
  ui.avatars = [];
  ui.chevronStarts = [];
  root = createRoot(container);
  await act(async () => root.render(<SectionList spaces={spaces} me={userOne} />));
  expect(heading().getAttribute("aria-label")).toBe("Expand Work");
  expect(names()).toEqual(["bot-c"]);
  expect(ui.avatars).not.toContain("bot-a");
  // Work's chevron mounts pointing right (no fold animation); Unassigned's mounts turned down.
  expect(ui.chevronStarts.slice(0, 2)).toEqual([0, 90]);

  // Another account on this device starts expanded; the saved account keeps its choice.
  render(<SectionList spaces={spaces} me={{ userId: "user-2" }} />);
  expect(names()).toEqual(["bot-a", "bot-b", "bot-c"]);
  render(<SectionList spaces={spaces} me={userOne} />);
  expect(names()).toEqual(["bot-c"]);
});

it("waits for a saved or live inbox before publishing a remounted session's search roster", () => {
  const publish = ui.setSearchInbox.mockReset();
  function PublishRoster({ me, inboxSpaces }: { me: object | null; inboxSpaces: InboxSpace[] }) {
    usePublishSearchInbox(inboxSpaces, me !== null);
    return null;
  }
  const me = { spaceId: "space-a" };
  const loaded = [
    { id: "space-a", bots: [{ id: "bot-a" }], groups: [] },
  ] as unknown as InboxSpace[];
  render(<PublishRoster key="session-1" me={null} inboxSpaces={[]} />);
  expect(publish).not.toHaveBeenCalled();
  // Either a verified saved inbox or the first live response supplies me and the roster.
  render(<PublishRoster key="session-1" me={me} inboxSpaces={loaded} />);
  expect(publish).toHaveBeenLastCalledWith(loaded);
  publish.mockClear();
  // HomeSession remounts Home for the new generation, even behind an unfocused route.
  render(<PublishRoster key="session-2" me={null} inboxSpaces={[]} />);
  expect(publish).not.toHaveBeenCalled();
  render(<PublishRoster key="session-2" me={me} inboxSpaces={loaded} />);
  expect(publish).toHaveBeenCalledExactlyOnceWith(loaded);
  // A loaded inbox may legitimately become empty; only the initial placeholder is skipped.
  render(<PublishRoster key="session-2" me={me} inboxSpaces={[]} />);
  expect(publish).toHaveBeenLastCalledWith([]);
});

it("offers Mute for a bot on a server that sends only its notification setting", () => {
  const items = [
    {
      type: "bot",
      bot: { id: "quiet", spaceId: "space-a", name: "Quiet", preview: "", notifyOnFinish: false },
    },
    {
      type: "bot",
      bot: { id: "loud", spaceId: "space-a", name: "Loud", preview: "", notifyOnFinish: true },
    },
    // Such a server cannot mute a group, so its menu offers no Mute.
    {
      type: "group",
      group: { id: "crew", spaceId: "space-a", name: "Crew", preview: "", members: [] },
    },
  ] as unknown as InboxItem[];
  render(<List items={items} spaceId="space-a" />);
  expect(ui.swipeMuted).toEqual([true, false, undefined]);
});

it("gives chats in every space the long-press menu, with their own space's sections", () => {
  const chat = (id: string, spaceId: string) => ({
    id,
    spaceId,
    name: id,
    preview: "",
    members: [],
  });
  const items = [
    { type: "bot", bot: chat("current-bot", "space-current") },
    { type: "group", group: chat("current-group", "space-current") },
    { type: "bot", bot: chat("other-bot", "space-other") },
    { type: "group", group: chat("other-group", "space-other") },
  ] as unknown as InboxItem[];
  const section = (id: string) => ({ id, name: id, position: 0, createdAt: "", updatedAt: "" });
  render(
    <List
      items={items}
      spaceId="space-current"
      options={{
        spaces: [
          { id: "space-current", botSections: [section("current-section")] },
          { id: "space-other", botSections: [section("other-section")] },
        ],
      }}
    />,
  );
  expect(ui.swipeRows).toEqual([
    "bot:current-bot current-section",
    "group:current-group current-section",
    "bot:other-bot other-section",
    "group:other-group other-section",
  ]);
  // A long press opens the menu and never the chat.
  const rows = Array.from(container.querySelectorAll("button"));
  expect(rows).toHaveLength(4);
  for (const row of rows) expect(row.dataset.longPress).toBe("true");
});

it("offers every space heading's Members and Settings, and Delete only where the member may delete it", () => {
  const confirmDeleteSpace = vi.fn();
  ui.push.mockReset();
  const heading = (id: string, name: string, canDelete: boolean) =>
    ({
      type: "heading",
      key: id,
      title: name,
      space: { id, name, isDefault: !canDelete, canDelete, bots: [], groups: [], botSections: [] },
    }) as unknown as InboxItem;
  render(
    <List
      items={[heading("space-home", "Home", false), heading("space-work", "Work", true)]}
      spaceId="space-home"
      options={{ confirmDeleteSpace }}
    />,
  );
  expect(ui.rowMenus.map((menu) => menu.actions.map((entry) => entry.id))).toEqual([
    ["new-bot", "members", "settings"],
    ["new-bot", "members", "settings", "delete"],
  ]);
  act(() => ui.rowMenus[1]!.onAction("members"));
  expect(ui.push).toHaveBeenLastCalledWith({
    pathname: "/space-members",
    params: { spaceId: "space-work", name: "Work" },
  });
  // Settings open the Space's own page, which edits that Space even when another is selected.
  act(() => ui.rowMenus[1]!.onAction("settings"));
  expect(ui.push).toHaveBeenCalledWith({
    pathname: "/space",
    params: { spaceId: "space-work", name: "Work" },
  });
  act(() => ui.rowMenus[1]!.onAction("delete"));
  expect(confirmDeleteSpace).toHaveBeenCalledWith(expect.objectContaining({ id: "space-work" }));
});

it("creates a bot in the heading's own space, and not while a space switch or recovery is under way", () => {
  const createBotInSpace = vi.fn();
  const heading = (id: string, name: string) =>
    ({
      type: "heading",
      key: id,
      title: name,
      space: { id, name, isDefault: false, canDelete: true, bots: [], groups: [], botSections: [] },
    }) as unknown as InboxItem;
  const items = [heading("space-home", "Home"), heading("space-work", "Work")];
  render(<List items={items} spaceId="space-home" options={{ createBotInSpace }} />);
  const newBot = (menu: NativeRowMenu) => menu.actions.find((entry) => entry.id === "new-bot");
  expect(ui.rowMenus.map((menu) => newBot(menu))).toEqual([
    expect.objectContaining({ title: "New bot", disabled: false }),
    expect.objectContaining({ title: "New bot", disabled: false }),
  ]);
  // A heading of a space that is not selected still makes the bot in that space.
  act(() => ui.rowMenus[1]!.onAction("new-bot"));
  expect(createBotInSpace).toHaveBeenCalledWith("space-work");
  for (const options of [{ spaceBusy: true }, { spaceRecoveryId: "space-home" }]) {
    ui.rowMenus = [];
    render(<List items={items} spaceId="space-home" options={{ createBotInSpace, ...options }} />);
    expect(ui.rowMenus.map((menu) => newBot(menu)?.disabled)).toEqual([true, true]);
  }
});

it("pins a bot made for a space to that space while another is selected", async () => {
  const bot = { id: "bot-new", name: "New Bot", spaceId: "space-work" };
  const spaces = () =>
    ui.rpc.mock.calls.map(([method, , options]) => [
      method,
      options?.requestContext?.headers["x-rakazo-space-id"],
    ]);
  ui.rpc
    .mockReset()
    .mockImplementation(async (method: string) => (method === "bots/create" ? bot : []));
  ui.searchInboxSession.mockReset().mockReturnValue({ generation: 7, apiBase: "http://api.test" });
  ui.addToSearchInbox.mockReset();
  await createInboxBot({
    input: { name: "Scout" },
    openChat: vi.fn(),
    spaceId: "space-work",
  });
  await vi.waitFor(() => expect(ui.rpc).toHaveBeenCalledTimes(4));
  expect(spaces()).toEqual([
    ["bots/list", "space-work"],
    ["me", "space-work"],
    ["bots/create", "space-work"],
    ["onboarding/start", "space-work"],
  ]);
  await vi.waitFor(() =>
    expect(scheduleFocusPrompt).toHaveBeenLastCalledWith(bot.id, true, {
      headers: { "x-rakazo-space-id": "space-work" },
    }),
  );
  // The Create menu's bot sends no pin, so it follows the selected space as before.
  ui.rpc.mockClear();
  await createInboxBot({ input: { name: "Scout" }, openChat: vi.fn() });
  await vi.waitFor(() => expect(ui.rpc).toHaveBeenCalledTimes(4));
  expect(spaces()).toEqual([
    ["bots/list", undefined],
    ["me", undefined],
    ["bots/create", undefined],
    ["onboarding/start", undefined],
  ]);
});

it.each(["session", "space"])(
  "abandons pinned creation if the %s changes while listing bots",
  async (change) => {
    let complete!: (value: unknown[]) => void;
    ui.rpc
      .mockReset()
      .mockImplementation(async (method: string) =>
        method === "bots/list" ? new Promise<unknown[]>((resolve) => (complete = resolve)) : {},
      );
    const openChat = vi.fn();
    const creating = createInboxBot({
      input: { name: "Scout" },
      openChat,
      spaceId: "space-work",
    });
    await vi.waitFor(() => expect(complete).toBeDefined());
    if (change === "session") ui.sameSession = false;
    else ui.spaceSeq += 2;
    complete([]);
    await creating;
    ui.sameSession = true;
    expect(ui.rpc.mock.calls.map(([method]) => method)).not.toContain("bots/create");
    expect(openChat).not.toHaveBeenCalled();
  },
);

it("does not open a created bot after its account or server changes", async () => {
  let complete!: (value: { id: string; name: string }) => void;
  ui.rpc
    .mockReset()
    .mockImplementation(async (method: string) =>
      method === "bots/create"
        ? new Promise<{ id: string; name: string }>((resolve) => (complete = resolve))
        : [{ id: "bot-existing" }],
    );
  const openChat = vi.fn();
  const creating = createInboxBot({
    input: { name: "Scout" },
    openChat,
    spaceId: "space-work",
  });
  await vi.waitFor(() => expect(complete).toBeDefined());
  ui.sameSession = false;
  complete({ id: "bot-new", name: "New Bot" });
  await creating;
  ui.sameSession = true;
  expect(openChat).not.toHaveBeenCalled();
});

it("opens a heading-created bot in its space after the selection changes during creation", async () => {
  const bot = { id: "bot-new", name: "New Bot", spaceId: "space-work" };
  let complete!: (value: typeof bot) => void;
  ui.rpc.mockReset().mockImplementation(async (method: string) => {
    if (method === "bots/create") return new Promise<typeof bot>((resolve) => (complete = resolve));
    return method === "bots/list" ? [{ id: "bot-existing" }] : {};
  });
  const openChat = vi.fn();
  const creating = createInboxBot({
    input: { name: "Scout" },
    openChat,
    spaceId: "space-work",
  });
  await vi.waitFor(() => expect(complete).toBeDefined());
  ui.spaceId = "space-other";
  ui.spaceSeq++;
  complete(bot);
  await creating;
  expect(openChat).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: bot.id, name: bot.name, spaceId: "space-work" },
  });
});

it.each([true, false])(
  "opens the chosen space's effective model settings (override: %s)",
  async (override) => {
    ui.alert.mockReset();
    ui.push.mockReset();
    ui.rpc.mockReset().mockImplementation(async (method: string) => {
      if (method === "me") return { needsModel: true };
      if (method === "spaceSettings/overrides") return override ? ["models"] : [];
      return [];
    });
    const openChat = vi.fn();
    await createInboxBot({ input: { name: "Scout" }, openChat, spaceId: "space-work" });
    expect(ui.rpc).toHaveBeenCalledWith("spaceSettings/overrides", undefined, {
      requestContext: { headers: { "x-rakazo-space-id": "space-work" } },
    });
    const buttons = ui.alert.mock.lastCall?.[2] as { text: string; onPress?: () => void }[];
    buttons.find((button) => button.text === "Add model")?.onPress?.();
    expect(ui.push).toHaveBeenCalledWith(
      override
        ? { pathname: "/(settings)/models", params: { spaceId: "space-work" } }
        : "/(settings)/models",
    );
    expect(ui.rpc.mock.calls.map(([method]) => method)).not.toContain("bots/create");
    expect(openChat).not.toHaveBeenCalled();
  },
);

it("asks for a model instead of making the first bot when the account has none", async () => {
  let me: Promise<unknown> = Promise.resolve({ needsModel: true });
  let bots: unknown[] = [];
  ui.push.mockReset();
  ui.alert.mockReset();
  ui.rpc.mockReset().mockImplementation(async (method: string) => {
    if (method === "me") return me;
    return method === "bots/list" ? bots : { id: "bot-new", name: "New Bot" };
  });
  const openChat = vi.fn();
  const create = () => createInboxBot({ input: { name: "Scout" }, openChat });
  const buttons = () =>
    ui.alert.mock.lastCall?.[2] as { text: string; onPress?: () => void }[] | undefined;
  const select = (spaceId: string) => {
    ui.spaceId = spaceId;
    ui.spaceSeq++;
  };

  await create();
  expect(ui.alert).toHaveBeenCalledWith("Add an AI model to keep chatting", undefined, [
    expect.objectContaining({ text: "Not Now" }),
    expect.objectContaining({ text: "Add model" }),
  ]);
  buttons()?.[0]?.onPress?.();
  expect(ui.push).not.toHaveBeenCalled();
  buttons()?.[1]?.onPress?.();
  expect(ui.push).toHaveBeenCalledWith("/(settings)/models");
  expect(ui.rpc).not.toHaveBeenCalledWith("bots/create", expect.anything(), undefined);
  expect(openChat).not.toHaveBeenCalled();

  // A read that lands after a switch of account or Space neither asks nor creates there.
  ui.alert.mockReset();
  const answers = [
    () => Promise.resolve({ needsModel: true }),
    () => Promise.resolve({ needsModel: false }),
    () => Promise.reject(new Error("down")),
  ];
  for (const answer of answers) {
    const leaves = [
      () => (ui.sameSession = false),
      () => select("space-b"),
      // A fallback after the Space is deleted elsewhere changes it without a selection.
      () => (ui.spaceId = "space-c"),
      // Back in A, the answer may still be B's: each read follows the Space selected when sent.
      () => {
        select("space-b");
        select("space-a");
      },
    ];
    for (const leave of leaves) {
      let land!: () => void;
      me = new Promise<void>((resolve) => (land = resolve)).then(answer);
      const moved = create();
      leave();
      land();
      await moved;
      ui.sameSession = true;
      select("space-a");
    }
  }
  expect(ui.alert).not.toHaveBeenCalled();
  expect(ui.rpc).not.toHaveBeenCalledWith("bots/create", expect.anything(), undefined);
  expect(openChat).not.toHaveBeenCalled();

  // Once a model is connected, or when `me` can't be read, Create makes the bot as before.
  for (const answer of [
    Promise.resolve({ needsModel: false }),
    Promise.reject(new Error("down")),
  ]) {
    me = answer;
    ui.rpc.mockClear();
    openChat.mockClear();
    await create();
    expect(ui.rpc).toHaveBeenCalledWith("bots/create", expect.anything(), undefined);
    expect(openChat).toHaveBeenCalledTimes(1);
  }

  // A list that fails isn't known to be empty, so Create makes the bot without asking.
  me = Promise.resolve({ needsModel: true });
  ui.rpc.mockClear();
  openChat.mockClear();
  const listed = ui.rpc.getMockImplementation();
  ui.rpc.mockImplementation(async (method: string, ...rest: unknown[]) =>
    method === "bots/list" ? Promise.reject(new Error("down")) : listed?.(method, ...rest),
  );
  await create();
  ui.rpc.mockImplementation(listed!);
  expect(ui.rpc).not.toHaveBeenCalledWith("me", undefined, undefined);
  expect(ui.alert).not.toHaveBeenCalled();
  expect(ui.rpc).toHaveBeenCalledWith("bots/create", expect.anything(), undefined);
  expect(openChat).toHaveBeenCalledTimes(1);

  // A later bot opens its chat, where the missing-model send error offers Add model.
  bots = [{ id: "bot-1" }];
  ui.rpc.mockClear();
  await create();
  expect(ui.rpc).toHaveBeenCalledWith("bots/create", expect.anything(), undefined);
  expect(ui.alert).not.toHaveBeenCalled();
  // Nor is a later bot made in the Space switched to while the list loaded.
  ui.rpc.mockClear();
  const moved = create();
  select("space-b");
  await moved;
  select("space-a");
  expect(ui.rpc).not.toHaveBeenCalledWith("bots/create", expect.anything(), undefined);
});

it("adds a bot made from the inbox's Create menu to the inbox roster before opening its chat", async () => {
  const bot = { id: "bot-new", name: "New Bot", spaceId: "space-a" };
  const askedIn = { generation: 7, apiBase: "http://api.test" };
  const calls: string[] = [];
  ui.rpc.mockReset().mockImplementation(async (method: string) => {
    calls.push(method);
    // A server that predates `needsModel` leaves it out of `me`.
    if (method === "me") return {};
    return method === "bots/create" ? bot : [];
  });
  ui.searchInboxSession.mockReset().mockImplementation(() => {
    calls.push("session");
    return askedIn;
  });
  ui.addToSearchInbox
    .mockReset()
    .mockImplementation((item: unknown, session: unknown) =>
      calls.push(`roster ${JSON.stringify(item)} ${JSON.stringify(session)}`),
    );
  await createInboxBot({
    input: { name: "Scout" },
    openChat: (destination) => calls.push(`open ${JSON.stringify(destination)}`),
  });
  // The server gives the bot the account's set, so the inbox sends none.
  expect(ui.rpc).toHaveBeenCalledWith(
    "bots/create",
    expect.not.objectContaining({ avatarSet: expect.anything() }),
    undefined,
  );
  expect(ui.rpc).toHaveBeenCalledWith(
    "bots/create",
    expect.objectContaining({ name: "Scout" }),
    undefined,
  );
  // The session is taken before the requests, so a bot that lands after a switch is dropped.
  expect(calls.slice(0, 8)).toEqual([
    "session",
    "bots/list",
    "me",
    "session",
    "bots/create",
    "session",
    `roster ${JSON.stringify({ kind: "bot", bot })} ${JSON.stringify(askedIn)}`,
    `open ${JSON.stringify({ pathname: "/thread", params: { botId: bot.id, name: bot.name } })}`,
  ]);
  expect(ui.hapticSuccess).toHaveBeenCalledOnce();
});

it("asks for a model as the New bot screen opens, only for a first bot without one", async () => {
  ui.searchInboxSession.mockReturnValue({ generation: 7, apiBase: "http://api.test" });
  ui.alert.mockReset();
  let bots: unknown[] = [];
  ui.rpc.mockReset().mockImplementation(async (method: string) => {
    if (method === "me") return { needsModel: true };
    if (method === "bots/create") return { id: "bot-new", name: "Scout" };
    return method === "bots/list" ? bots : [];
  });
  expect(await askForModelBeforeFirstBot(undefined, () => true)).toBe(true);
  expect(ui.alert).toHaveBeenCalledOnce();
  bots = [{ id: "bot-existing" }];
  expect(await askForModelBeforeFirstBot(undefined, () => true)).toBe(false);
  expect(await createInboxBot({ input: { name: "Scout" }, openChat: vi.fn() })).toBe("created");
  bots = [];
  expect(await createInboxBot({ input: { name: "Scout" }, openChat: vi.fn() })).toBe("needsModel");
  expect(ui.rpc.mock.calls.filter(([method]) => method === "bots/create")).toHaveLength(1);
});

it("does not ask for a model after the space changes during the opening check", async () => {
  ui.searchInboxSession.mockReturnValue({ generation: 7, apiBase: "http://api.test" });
  ui.alert.mockReset();
  ui.rpc.mockReset().mockImplementation(async (method: string) => {
    if (method === "bots/list") {
      ui.spaceSeq++;
      return [];
    }
    return method === "me" ? { needsModel: true } : [];
  });
  expect(await askForModelBeforeFirstBot("space-work", () => true)).toBe(false);
  expect(ui.alert).not.toHaveBeenCalled();
});

it("does not ask for a model once the New bot screen has closed", async () => {
  ui.searchInboxSession.mockReturnValue({ generation: 7, apiBase: "http://api.test" });
  ui.alert.mockReset();
  ui.rpc
    .mockReset()
    .mockImplementation(async (method: string) => (method === "me" ? { needsModel: true } : []));
  expect(await askForModelBeforeFirstBot(undefined, () => false)).toBe(false);
  expect(ui.alert).not.toHaveBeenCalled();
});

it("tells the inbox to reload once the bot exists", async () => {
  ui.searchInboxSession.mockReturnValue({ generation: 7, apiBase: "http://api.test" });
  ui.rpc
    .mockReset()
    .mockImplementation(async (method: string) =>
      method === "bots/create" ? { id: "bot-new", name: "Scout" } : [{ id: "bot-existing" }],
    );
  const changed = vi.fn();
  const stop = onInboxChanged(changed);
  await createInboxBot({ input: { name: "Scout" }, openChat: vi.fn() });
  stop();
  expect(changed).toHaveBeenCalledOnce();
});

it("does not confirm a failed inbox bot creation with success feedback", async () => {
  ui.searchInboxSession.mockReturnValue({ generation: 7, apiBase: "http://api.test" });
  ui.rpc.mockReset().mockImplementation(async (method: string) => {
    if (method === "bots/create") throw new Error("Creation failed");
    return [];
  });
  await expect(createInboxBot({ input: { name: "Scout" }, openChat: vi.fn() })).rejects.toThrow(
    "Creation failed",
  );
  expect(ui.hapticSuccess).not.toHaveBeenCalled();
});

it.each([
  { generation: 8, apiBase: "http://api.test" },
  { generation: 7, apiBase: "http://other.test" },
])("does not confirm an inbox bot created in an obsolete session: %j", async (current) => {
  const askedIn = { generation: 7, apiBase: "http://api.test" };
  ui.searchInboxSession.mockReset().mockReturnValue(askedIn);
  let finish!: (bot: { id: string; name: string }) => void;
  ui.rpc.mockReset().mockImplementation(async (method: string) =>
    method === "bots/create"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : [],
  );
  const creating = createInboxBot({ input: { name: "Scout" }, openChat: vi.fn() });
  await vi.waitFor(() =>
    expect(ui.rpc).toHaveBeenCalledWith("bots/create", expect.anything(), undefined),
  );
  ui.searchInboxSession.mockReturnValue(current);
  finish({ id: "bot-new", name: "New Bot" });
  await creating;
  expect(ui.hapticSuccess).not.toHaveBeenCalled();
});

it("lets screen readers reach a heading's long-press menu through the heading", () => {
  const deleteSection = vi.fn();
  const confirmDeleteSpace = vi.fn();
  render(
    <List
      items={[
        {
          type: "heading",
          key: "space-work",
          title: "Work",
          space: {
            id: "space-work",
            name: "Work",
            isDefault: false,
            canDelete: true,
            bots: [],
            groups: [],
            botSections: [],
          },
        } as unknown as InboxItem,
        { type: "heading", key: "section:s1", title: "Ideas", sectionId: "s1" } as InboxItem,
      ]}
      spaceId="space-home"
      options={{ deleteSection, confirmDeleteSpace }}
    />,
  );
  const space = container.querySelector<HTMLElement>('button[aria-label="Work"]')!;
  // A disabled item is left out; here none is.
  expect(space.dataset.actions).toBe("new-bot members settings delete");
  const section = container.querySelector<HTMLElement>('button[aria-label="Collapse Ideas"]')!;
  expect(section.dataset.actions).toBe("delete");
  act(() => ui.a11yActions.get("Collapse Ideas")!({ nativeEvent: { actionName: "delete" } }));
  expect(deleteSection).toHaveBeenCalledWith({ id: "s1", name: "Ideas" });
  act(() => ui.a11yActions.get("Work")!({ nativeEvent: { actionName: "delete" } }));
  expect(confirmDeleteSpace).toHaveBeenCalledWith(expect.objectContaining({ id: "space-work" }));
});
