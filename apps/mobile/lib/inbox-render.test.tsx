// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ComponentType, ReactElement } from "react";
import * as React from "react";
import { act, memo, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import type { MobileBot } from "./api";
import { formatThreadTime } from "./inbox";
import { retainInboxValue } from "./inbox-retention";

const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8");

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
    previewSnippet: (text: string) => text,
    formatThreadTime: () => "",
    botTag: () => "",
    ACTIVE_RUN_STATUSES: ["running"],
    mobileBotAvatarPresentation: () => {
      renders++;
      return { kind: "color", color: "gray" };
    },
    FALLBACK_COLOR: "gray",
    ConversationRow: () => null,
    BotAvatar: () => null,
    WorkingIndicator: () => null,
  };
  const compile = (text: string) =>
    ts.transpileModule(text, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
  const BotRow = new Function(...Object.keys(scope), compile(`${rowSource}\nreturn BotRow;`))(
    ...Object.values(scope),
  );
  const action = vi.fn();
  const dependencies = {
    React,
    useCallback,
    BotRow,
    appearance: "light",
    day: new Date(2026, 9, 10).getTime(),
    chooseInboxSpace: action,
    collapsedRosterParents: new Set(),
    confirmDeleteSpace: action,
    me: { spaceId: "space-1" },
    openBot: action,
    openGroup: action,
    openSearchHit: action,
    organizeBot: action,
    organizeGroup: action,
    spaceBusy: false,
    spaceRecoveryId: null,
    styles: {},
    t: action,
    toggleRosterParent: action,
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
        React.cloneElement(
          renderItem({ item: { type: "bot", bot, depth: 0, hasChildren: false } }),
          { key: bot.id },
        )
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
      ACTIVE_RUN_STATUSES: ["running"],
      mobileBotAvatarPresentation: () => ({ kind: "color", color: "gray" }),
      FALLBACK_COLOR: "gray",
      ConversationRow: ({ time }: { time: string }) => <span>{time}</span>,
      BotAvatar: () => null,
      GroupAvatar: () => null,
      WorkingIndicator: () => null,
      appearance: "light",
      chooseInboxSpace: action,
      collapsedRosterParents: new Set(),
      confirmDeleteSpace: action,
      me: { spaceId: "space-1" },
      openBot: action,
      openGroup: action,
      openSearchHit: action,
      organizeBot: action,
      organizeGroup: action,
      spaceBusy: false,
      spaceRecoveryId: null,
      styles: {},
      t: action,
      toggleRosterParent: action,
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
      `${rowSource}\nreturn function List({ items }) {\n${daySource}\n${listSource}
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
