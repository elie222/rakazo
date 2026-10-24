// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { ACTIVE_RUN_STATUSES, isRunWorking } from "@rakazo/core";
import type { ComponentType, ReactElement, ReactNode } from "react";
import * as React from "react";
import { act, memo, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import type { MobileBot } from "./api";
import { botTag, formatThreadTime } from "./inbox";
import { retainInboxValue } from "./inbox-retention";
import { spaceInboxItems } from "./inbox-spaces";
import { inboxRowActionList } from "./inbox-swipe";

// Section headings use the real item builder; its space actions stay unused here.
vi.mock("./api", () => ({}));

const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8");
const rowDimensions = source.slice(
  source.indexOf("const INBOX_ROW ="),
  source.indexOf("function ConversationRow("),
);

// Run the actual row and renderItem code with native presentation stubbed out.
// React still performs real memo comparisons; this measures JS row executions only.
function measure(before: boolean) {
  let renders = 0;
  const rowSource = source.slice(
    source.indexOf("const BotRow = memo("),
    source.indexOf("const GroupRow = memo("),
  );
  const listSource = source.slice(
    source.indexOf("  const renderItem = useCallback("),
    source.indexOf("  if (!ready) {"),
  );
  const scope = {
    React,
    memo: before ? (component: ComponentType) => component : memo,
    useCallback,
    useI18n: () => ({ t: (text: string) => text }),
    previewSnippet: (text: string) => {
      renders++;
      return text;
    },
    formatThreadTime: () => "",
    botTag: () => "",
    isRunWorking,
    FALLBACK_COLOR: "gray",
    ConversationRow: () => null,
    BotAvatar: () => null,
    AvatarRow: ({ children }: { children: ReactElement }) => children,
    // Rows in the current space carry the iOS swipe host; it must not defeat the memo.
    InboxSwipeRow: ({ children }: { children: ReactElement }) => children,
    inboxRowActionList,
  };
  const compile = (text: string) =>
    ts.transpileModule(text, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
  const BotRow = new Function(
    ...Object.keys(scope),
    compile(`${rowDimensions}\n${rowSource}\nreturn BotRow;`),
  )(...Object.values(scope));
  const action = vi.fn();
  const dependencies = {
    React,
    useCallback,
    BotRow,
    appearance: "light",
    botAction: action,
    botSections: [],
    editSectionFromMenu: action,
    organizeFromMenu: action,
    SWIPE_ROWS: true,
    day: new Date(2026, 9, 10).getTime(),
    chooseInboxSpace: action,
    collapsed: new Set(),
    confirmDeleteSpace: action,
    deleteSection: action,
    me: { spaceId: "space-1" },
    onShareSelect: undefined,
    openBot: action,
    openGroup: action,
    groupAction: action,
    organizeBot: action,
    organizeGroup: action,
    spaceBusy: false,
    spaceRecoveryId: null,
    styles: {},
    t: action,
    toggleCollapsed: action,
  };
  const useRenderItem = new Function(
    ...Object.keys(dependencies),
    compile(`${listSource}\nreturn renderItem;`),
  );
  let previousRenderItem: unknown;
  function List({ bots }: { bots: MobileBot[] }) {
    const renderItem = useRenderItem(...Object.values(dependencies)) as (info: {
      item: unknown;
    }) => ReactElement;
    if (previousRenderItem) expect(renderItem).toBe(previousRenderItem);
    previousRenderItem = renderItem;
    return bots.map((bot) =>
      before ? (
        <BotRow
          key={bot.id}
          bot={bot}
          onPress={() => action(bot)}
          onLongPress={() => action(bot)}
        />
      ) : (
        React.cloneElement(renderItem({ item: { type: "bot", bot } }), { key: bot.id })
      ),
    );
  }
  let bots = Array.from({ length: 30 }, (_, index) => ({
    id: `bot-${index}`,
    name: `Helper ${index}`,
    spaceId: "space-1",
    preview: "",
    title: "",
    color: "gray",
    status: "idle",
    notifyOnFinish: true,
    unread: false,
  })) as MobileBot[];
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<List bots={bots} />));
    const mount = renders;
    for (let poll = 0; poll < 12; poll++) {
      const fetched = structuredClone(bots);
      bots = before ? fetched : retainInboxValue(bots, fetched);
      // Force parent rendering too, as with activity/refresh state changes.
      act(() => root.render(<List bots={bots} />));
    }
    const idle = renders - mount;
    const fetched = structuredClone(bots);
    fetched[0]!.status = "running";
    fetched[0]!.unread = true;
    bots = before ? fetched : retainInboxValue(bots, fetched);
    act(() => root.render(<List bots={bots} />));
    return { mount, idle, changed: renders - mount - idle };
  } finally {
    act(() => root.unmount());
  }
}

it("skips unchanged inbox rows for 12 idle polls and renders the changed bot", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    expect(measure(true)).toEqual({ mount: 30, idle: 360, changed: 30 });
    expect(measure(false)).toEqual({ mount: 30, idle: 0, changed: 1 });
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["midnight", "focus", "foreground"])(
  "refreshes unchanged bot and group timestamps on %s",
  (trigger) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 10, 23, 59));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let focused = true;
    let onAppStateChange: ((state: string) => void) | undefined;
    const remove = vi.fn(() => {
      onAppStateChange = undefined;
    });
    const action = vi.fn();
    const scope = {
      React,
      memo,
      useCallback,
      useState,
      useFocusEffect: (effect: () => (() => void) | undefined) => {
        useEffect(() => (focused ? effect() : undefined), [effect, focused]);
      },
      AppState: {
        addEventListener: (_event: string, listener: (state: string) => void) => {
          onAppStateChange = listener;
          return { remove };
        },
      },
      useI18n: () => ({ t: (text: string) => text }),
      previewSnippet: (text: string) => text,
      formatThreadTime,
      botTag: () => "",
      isRunWorking,
      FALLBACK_COLOR: "gray",
      ConversationRow: ({ time }: { time: string }) => <span>{time}</span>,
      BotAvatar: () => null,
      AvatarRow: ({ children }: { children: ReactElement }) => children,
      GroupAvatar: () => null,
      InboxSwipeRow: ({ children }: { children: ReactElement }) => children,
      inboxRowActionList,
      appearance: "light",
      botAction: action,
      groupAction: action,
      botSections: [],
      editSectionFromMenu: action,
      organizeFromMenu: action,
      SWIPE_ROWS: true,
      chooseInboxSpace: action,
      collapsed: new Set(),
      confirmDeleteSpace: action,
      deleteSection: action,
      me: { spaceId: "space-1" },
      onShareSelect: undefined,
      openBot: action,
      openGroup: action,
      organizeBot: action,
      organizeGroup: action,
      spaceBusy: false,
      spaceRecoveryId: null,
      styles: {},
      t: action,
      toggleCollapsed: action,
    };
    const rowSource = source.slice(
      source.indexOf("const BotRow = memo("),
      source.indexOf("function createHomeStyles()"),
    );
    const daySource = source.slice(
      source.indexOf("  const [day, setDay]"),
      source.indexOf("  const [bots, setBots]"),
    );
    const listSource = source.slice(
      source.indexOf("  const renderItem = useCallback("),
      source.indexOf("  if (!ready) {"),
    );
    const compiled = ts.transpileModule(
      `${rowDimensions}\n${rowSource}\nreturn function List({ items }) {\n${daySource}\n${listSource}
        return items.map((item, index) => React.cloneElement(renderItem({ item }), { key: index }));
      };`,
      { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const List = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
    const today = new Date(2026, 9, 10, 12, 30).toISOString();
    const sixDaysAgo = new Date(2026, 9, 4, 12, 30).toISOString();
    // Keep the response and every row object identical throughout the date change.
    const items = [today, sixDaysAgo].flatMap((updatedAt) => [
      { type: "bot", bot: { id: updatedAt, name: "Helper", preview: "", updatedAt } },
      {
        type: "group",
        group: { id: updatedAt, name: "Team", preview: "", members: [], updatedAt },
      },
    ]);
    const container = document.createElement("div");
    const root = createRoot(container);
    const labels = () => Array.from(container.querySelectorAll("span"), (span) => span.textContent);
    try {
      act(() => root.render(<List items={items} />));
      const weekday = formatThreadTime(sixDaysAgo);
      expect(labels()).toEqual(["12:30", "12:30", weekday, weekday]);
      if (trigger === "focus") {
        focused = false;
        act(() => root.render(<List items={items} />));
        expect(onAppStateChange).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      }
      if (trigger === "midnight") {
        act(() => vi.advanceTimersByTime(60_000));
      } else {
        // Suspended native timers need not fire before the app returns.
        vi.setSystemTime(new Date(2026, 9, 11, 8));
        act(() => {
          if (trigger === "foreground") onAppStateChange?.("active");
          else {
            focused = true;
            root.render(<List items={items} />);
          }
        });
      }
      expect(labels()).toEqual([
        formatThreadTime(today),
        formatThreadTime(today),
        formatThreadTime(sixDaysAgo),
        formatThreadTime(sixDaysAgo),
      ]);
      expect(labels()[0]).not.toBe("12:30");
      expect(labels()[2]).not.toBe(weekday);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      act(() => root.unmount());
      expect(onAppStateChange).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  },
);

it("renders saved bot rows without a title or notification setting", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const scope = {
    React,
    memo,
    useI18n: () => ({ t: (text: string) => text }),
    previewSnippet: (text: string) => text,
    formatThreadTime,
    botTag,
    isRunWorking,
    FALLBACK_COLOR: "gray",
    ConversationRow: ({
      tag,
      preview,
      accessibilityLabel,
      avatar,
    }: {
      tag: string;
      preview: string;
      accessibilityLabel: string;
      avatar: ReactElement;
    }) => (
      <span>
        {[tag, preview, accessibilityLabel].join("|")}
        {avatar}
      </span>
    ),
    BotAvatar: ({ muted, motion }: { muted: boolean; motion?: string }) =>
      `${muted ? " muted" : ""}${motion ? ` ${motion}` : ""}`,
    // The row's avatar freezes while the row is scrolled out of view.
    AvatarRow: ({ id, children }: { id: string; children: ReactElement }) => (
      <i data-row={id}>{children}</i>
    ),
  };
  const rowSource = source.slice(
    source.indexOf("const BotRow = memo("),
    source.indexOf("const GroupRow = memo("),
  );
  const compiled = ts.transpileModule(`${rowDimensions}\n${rowSource}\nreturn BotRow;`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const BotRow = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
  // Inboxes saved before titles and notification settings were kept have bots without them.
  const bots = [
    { id: "bot-a", name: "Alpha", title: "Research", preview: "", notifyOnFinish: true },
    { id: "bot-b", name: "Beta", preview: "" },
    { id: "bot-c", name: "Gamma", title: "", preview: "", notifyOnFinish: false },
  ];
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        bots.map((bot) => <BotRow key={bot.id} bot={bot} day={0} onPress={() => undefined} />),
      ),
    );
    expect(Array.from(container.querySelectorAll("span"), (span) => span.textContent)).toEqual([
      "Research|Research|Alpha, Research, Research lazy",
      "|No messages yet|Beta, No messages yet lazy",
      "|No messages yet|Gamma, notifications silenced, No messages yet muted lazy",
    ]);
    expect(Array.from(container.querySelectorAll("i"), (row) => row.dataset.row)).toEqual([
      "bot-a",
      "bot-b",
      "bot-c",
    ]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("says working only while the bot works, and shows nothing beside the time", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const scope = {
    React,
    memo,
    useI18n: () => ({ t: (text: string) => text }),
    previewSnippet: (text: string) => text,
    formatThreadTime,
    botTag: () => "",
    ACTIVE_RUN_STATUSES,
    isRunWorking,
    FALLBACK_COLOR: "gray",
    // The avatar's motion and corner dot are the only working sign; the time stands alone.
    ConversationRow: (props: { accessibilityLabel: string }) => (
      <span data-indicator={"indicator" in props}>{props.accessibilityLabel}</span>
    ),
    BotAvatar: () => null,
    AvatarRow: ({ children }: { children: ReactElement }) => children,
  };
  const rowSource = source.slice(
    source.indexOf("const BotRow = memo("),
    source.indexOf("const GroupRow = memo("),
  );
  const compiled = ts.transpileModule(`${rowDimensions}\n${rowSource}\nreturn BotRow;`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const BotRow = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
  const bots = ["running", "waiting_takeover", "waiting_input", "idle"].map((status) => ({
    id: status,
    name: "Helper",
    preview: "Hi",
    status,
  }));
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        bots.map((bot) => <BotRow key={bot.id} bot={bot} day={0} onPress={() => undefined} />),
      ),
    );
    // A "Needs you" computer card or an ask card is the state; the row must not claim work.
    expect(
      Array.from(container.querySelectorAll("span"), (span) => span.dataset.indicator),
    ).toEqual(["false", "false", "false", "false"]);
    expect(Array.from(container.querySelectorAll("span"), (span) => span.textContent)).toEqual([
      "Helper, Working…, Hi",
      "Helper, Hi",
      "Helper, Hi",
      "Helper, Hi",
    ]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("ties the pinned tiles' avatars to the pinned row, so they freeze when it scrolls away", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const action = vi.fn();
  const listSource = source.slice(
    source.indexOf("  const renderItem = useCallback("),
    source.indexOf("  if (!ready) {"),
  );
  // The list's own key for each item.
  const keySource = source.slice(
    source.indexOf("function inboxItemKey("),
    source.indexOf("function inboxSignal("),
  );
  const scope = {
    React,
    useCallback,
    AvatarRow: ({ id, children }: { id: string; children: ReactElement }) => (
      <i data-row={id}>{children}</i>
    ),
    PinnedTiles: () => <b />,
    appearance: "light",
    botAction: action,
    botSections: [],
    chooseInboxSpace: action,
    collapsed: new Set(),
    confirmDeleteSpace: action,
    deleteSection: action,
    day: 0,
    editSectionFromMenu: action,
    groupAction: action,
    me: { spaceId: "space-1" },
    onShareSelect: undefined,
    openBot: action,
    openGroup: action,
    organizeBot: action,
    organizeFromMenu: action,
    organizeGroup: action,
    spaceBusy: false,
    spaceRecoveryId: null,
    styles: {},
    t: action,
    toggleCollapsed: action,
  };
  const compiled = ts.transpileModule(
    `${keySource}\nreturn function List() {\n${listSource}\nreturn renderItem({ item: { type: "pinned", chats: [] } });\n};`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const List = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<List />));
    expect(container.querySelector('[data-row="pinned"] > b')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("collapses a section from its heading and keeps the choice for the account", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const action = vi.fn();
  const loadCollapsedSections = vi.fn(
    async (): Promise<{ userId: string; keys: Set<string> } | null> => null,
  );
  const saveCollapsedSections = vi.fn();
  const renderedRows: string[] = [];
  const chevrons: boolean[] = [];
  const scope = {
    React,
    useCallback,
    useEffect,
    useMemo,
    useState,
    spaceInboxItems,
    loadSessionToken: async () => "token",
    loadCollapsedSections,
    saveCollapsedSections,
    Platform: { OS: "ios" },
    View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Pressable: ({
      children,
      accessibilityLabel,
      accessibilityState,
      accessibilityValue,
      onPress,
      style,
    }: {
      children: ReactNode;
      accessibilityLabel?: string;
      accessibilityState?: { expanded?: boolean };
      accessibilityValue?: { text?: string };
      onPress?: () => void;
      style?: (state: { pressed: boolean }) => ({ minHeight?: number } | false)[];
    }) => (
      <button
        type="button"
        aria-label={accessibilityLabel}
        aria-expanded={accessibilityState?.expanded}
        data-value={accessibilityValue?.text}
        data-min-height={Object.assign({}, ...(style?.({ pressed: false }) ?? [])).minHeight}
        onClick={onPress}
      >
        {children}
      </button>
    ),
    MenuView: ({ children }: { children: ReactNode }) => children,
    NativeSymbol: () => null,
    SectionChevron: ({ collapsed }: { collapsed: boolean }) => {
      chevrons.push(collapsed);
      return <i data-collapsed={String(collapsed)} />;
    },
    BotRow: ({ bot }: { bot: MobileBot }) => {
      renderedRows.push(bot.name);
      return <p>{bot.name}</p>;
    },
    GroupRow: () => null,
    appearance: "light",
    botAction: action,
    botSections: [],
    chooseInboxSpace: action,
    confirmDeleteSpace: action,
    deleteSection: action,
    day: 0,
    editSectionFromMenu: action,
    groupAction: action,
    onShareSelect: undefined,
    openBot: action,
    openGroup: action,
    organizeBot: action,
    organizeFromMenu: action,
    organizeGroup: action,
    spaceBusy: false,
    spaceRecoveryId: null,
    // The heading's own style, so its tap target is checked against the real value.
    styles: new Function(
      `return {${source.slice(source.indexOf("    sectionToggle: {"), source.indexOf("    sectionTitle: {"))}};`,
    )(),
    t: (text: string, values?: { name?: string }) => text.replace("{name}", values?.name ?? ""),
    SWIPE_ROWS: true,
  };
  const slice = (from: string, to: string) =>
    source.slice(source.indexOf(from), source.indexOf(to));
  const stateSource = slice(
    "  // Roster parent bot ids and section heading keys",
    "  useEffect(() => {\n    void loadActivityMode()",
  );
  const sessionSource = slice(
    "  useEffect(() => {\n    void Promise.all([loadSessionToken(), loadCollapsedSections()])",
    "  useEffect(() => {\n    if (!hasSession || onShareSelect) return;\n    void registerPushToken",
  );
  const listSource = slice("  const renderItem = useCallback(", "  if (!ready) {");
  const compiled = ts.transpileModule(
    `return function List({ spaces, me }) {
      const [ready, setReady] = useState(false);
      const [, setHasSession] = useState(false);
      ${stateSource}\n${sessionSource}\n${listSource}
      if (!ready) return null;
      return spaceInboxItems(spaces, collapsed, me.spaceId).map((item, index) =>
        React.cloneElement(renderItem({ item }), { key: index }),
      );
    };`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const List = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
  const work = {
    id: "work",
    name: "Work",
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const spaces = [
    {
      id: "space-1",
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
  ];
  const userOne = { userId: "user-1", spaceId: "space-1" };
  const container = document.createElement("div");
  const root = createRoot(container);
  const heading = () => container.querySelector("button")!;
  const names = () => Array.from(container.querySelectorAll("p"), (row) => row.textContent);
  try {
    await act(async () => root.render(<List spaces={spaces} me={userOne} />));
    expect(loadCollapsedSections).toHaveBeenCalledTimes(1);
    expect(heading().getAttribute("aria-label")).toBe("Collapse Work");
    expect(heading().getAttribute("aria-expanded")).toBe("true");
    expect(heading().hasAttribute("data-value")).toBe(false);
    expect(heading().textContent).toBe("Work");
    // Every heading is a full tap target, with or without the section "…" menu beside it.
    expect(heading().dataset.minHeight).toBe("44");
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);

    act(() => heading().click());
    expect(heading().getAttribute("aria-label")).toBe("Expand Work");
    expect(heading().getAttribute("aria-expanded")).toBe("false");
    expect(heading().getAttribute("data-value")).toBe("2");
    expect(heading().textContent).toBe("Work2");
    expect(heading().querySelector("i")?.dataset.collapsed).toBe("true");
    expect(names()).toEqual(["Gamma"]);
    expect(saveCollapsedSections).toHaveBeenLastCalledWith(
      "user-1",
      new Set(["space-1:section:work"]),
    );

    act(() => heading().click());
    expect(heading().getAttribute("aria-label")).toBe("Collapse Work");
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(saveCollapsedSections).toHaveBeenLastCalledWith("user-1", new Set());

    // Quick taps save once per committed state, the final one last.
    act(() => {
      heading().click();
      heading().click();
      heading().click();
    });
    expect(heading().getAttribute("aria-label")).toBe("Expand Work");
    expect(saveCollapsedSections).toHaveBeenLastCalledWith(
      "user-1",
      new Set(["space-1:section:work"]),
    );
  } finally {
    act(() => root.unmount());
  }

  // A relaunch draws the account's collapsed sections folded from the first frame.
  loadCollapsedSections.mockResolvedValueOnce({
    userId: "user-1",
    keys: new Set(["space-1:section:work"]),
  });
  renderedRows.length = 0;
  chevrons.length = 0;
  const relaunched = createRoot(container);
  try {
    await act(async () => relaunched.render(<List spaces={spaces} me={userOne} />));
    expect(heading().getAttribute("aria-label")).toBe("Expand Work");
    expect(names()).toEqual(["Gamma"]);
    expect(renderedRows).not.toContain("Alpha");
    // Work's chevron mounts collapsed (no fold animation); Unassigned's mounts expanded.
    expect(chevrons.slice(0, 2)).toEqual([true, false]);

    // Another account on this device starts expanded; the saved account keeps its choice.
    act(() => relaunched.render(<List spaces={spaces} me={{ ...userOne, userId: "user-2" }} />));
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);
    act(() => relaunched.render(<List spaces={spaces} me={userOne} />));
    expect(names()).toEqual(["Gamma"]);
  } finally {
    act(() => relaunched.unmount());
    vi.unstubAllGlobals();
  }
});

it("waits for a saved or live inbox before publishing a remounted session's search roster", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const publish = vi.fn();
  const effectStart = source.indexOf(
    "  useEffect(() => {\n",
    source.indexOf("  const inboxSpaces ="),
  );
  const effect = source.slice(effectStart, source.indexOf("  const listData =", effectStart));
  const compiled = ts.transpileModule(
    `return function PublishRoster({ me, inboxSpaces }) { ${effect}\nreturn null; };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const PublishRoster = new Function("useEffect", "setSearchInbox", compiled)(
    useEffect,
    publish,
  ) as ComponentType<{ me: { spaceId: string } | null; inboxSpaces: unknown[] }>;
  const root = createRoot(document.createElement("div"));
  const loaded = [{ id: "space-a", bots: [{ id: "bot-a" }], groups: [] }];
  try {
    act(() => root.render(<PublishRoster key="session-1" me={null} inboxSpaces={[]} />));
    expect(publish).not.toHaveBeenCalled();
    // Either a verified saved inbox or the first live response supplies me and the roster.
    act(() =>
      root.render(
        <PublishRoster key="session-1" me={{ spaceId: "space-a" }} inboxSpaces={loaded} />,
      ),
    );
    expect(publish).toHaveBeenLastCalledWith(loaded);
    publish.mockClear();
    // HomeSession remounts Home for the new generation, even behind an unfocused route.
    act(() => root.render(<PublishRoster key="session-2" me={null} inboxSpaces={[]} />));
    expect(publish).not.toHaveBeenCalled();
    act(() =>
      root.render(
        <PublishRoster key="session-2" me={{ spaceId: "space-a" }} inboxSpaces={loaded} />,
      ),
    );
    expect(publish).toHaveBeenCalledExactlyOnceWith(loaded);
    // A loaded inbox may legitimately become empty; only the initial placeholder is skipped.
    act(() =>
      root.render(<PublishRoster key="session-2" me={{ spaceId: "space-a" }} inboxSpaces={[]} />),
    );
    expect(publish).toHaveBeenLastCalledWith([]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("gives the long-press menu, and with it Delete, only to chats in the current space", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const action = vi.fn();
  const withMenu: string[] = [];
  const scope = {
    React,
    memo,
    useCallback,
    useI18n: () => ({ t: (text: string) => text }),
    previewSnippet: (text: string) => text,
    formatThreadTime: () => "",
    botTag: () => "",
    ACTIVE_RUN_STATUSES,
    isRunWorking,
    FALLBACK_COLOR: "gray",
    ConversationRow: () => null,
    BotAvatar: () => null,
    AvatarRow: ({ children }: { children: ReactElement }) => children,
    GroupAvatar: () => null,
    InboxSwipeRow: ({ rowKey }: { rowKey: string }) => {
      withMenu.push(rowKey);
      return null;
    },
    inboxRowActionList,
    appearance: "light",
    botAction: action,
    groupAction: action,
    botSections: [],
    editSectionFromMenu: action,
    organizeFromMenu: action,
    SWIPE_ROWS: true,
    day: 0,
    chooseInboxSpace: action,
    collapsed: new Set(),
    confirmDeleteSpace: action,
    deleteSection: action,
    me: { spaceId: "space-current" },
    onShareSelect: undefined,
    openBot: action,
    openGroup: action,
    organizeBot: action,
    organizeGroup: action,
    spaceBusy: false,
    spaceRecoveryId: null,
    styles: {},
    t: action,
    toggleCollapsed: action,
  };
  const rowSource = source.slice(
    source.indexOf("const BotRow = memo("),
    source.indexOf("function createHomeStyles()"),
  );
  const listSource = source.slice(
    source.indexOf("  const renderItem = useCallback("),
    source.indexOf("  if (!ready) {"),
  );
  const compiled = ts.transpileModule(
    `${rowDimensions}\n${rowSource}\nreturn function List({ items }) {\n${listSource}
      return items.map((item, index) => React.cloneElement(renderItem({ item }), { key: index }));
    };`,
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const List = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
  const chat = (id: string, spaceId: string) => ({
    id,
    spaceId,
    name: id,
    preview: "",
    members: [],
  });
  // Chats listed from another space have no row menu, as with Archive.
  const items = [
    { type: "bot", bot: chat("current-bot", "space-current") },
    { type: "group", group: chat("current-group", "space-current") },
    { type: "bot", bot: chat("other-bot", "space-other") },
    { type: "group", group: chat("other-group", "space-other") },
  ];
  const root = createRoot(document.createElement("div"));
  try {
    act(() => root.render(<List items={items} />));
    expect(withMenu).toEqual(["bot:current-bot", "group:current-group"]);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
