// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import * as React from "react";
import { act, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { loadArchivedChats } from "./archived-chats";
import {
  archivedChatCounts,
  notifyArchivedChatsChanged,
  onArchivedChatsChanged,
} from "./archived-chats";
import { confirmDeleteGroup } from "./bot-lifecycle";

const { groupRpc, groupAlert } = vi.hoisted(() => ({
  groupRpc: vi.fn(),
  groupAlert: vi.fn(),
}));
vi.mock("./api", () => ({ rpc: groupRpc }));
vi.mock("react-native", () => ({ Alert: { alert: groupAlert } }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./user-error", () => ({ errorText: () => "failure" }));

const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8");
const slice = (start: string, end: string) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
};
const compile = (text: string) =>
  ts.transpileModule(text, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

describe("archived chats row", () => {
  let compact = false;
  const dimensions = slice("const INBOX_ROW =", "function ConversationRow(");
  const styles = new Function(
    "mobileTokens",
    "StyleSheet",
    "native",
    "typeScale",
    "fontWeight",
    compile(
      `${dimensions}\n${source.slice(source.indexOf("function createHomeStyles()"))}\nreturn createHomeStyles();`,
    ),
  )(() => ({}), { create: (value: unknown) => value }, {}, typeScale, fontWeight);
  const ArchivedChatsRow = new Function(
    "React",
    "useContext",
    "CompactRowsContext",
    "useThemedStyles",
    "useI18n",
    "View",
    "Pressable",
    "Text",
    "NativeSymbol",
    "native",
    "createHomeStyles",
    compile(
      `${dimensions}\n${slice("function ArchivedChatsRow(", "/** Points right while a section")}\nreturn ArchivedChatsRow;`,
    ),
  )(
    React,
    () => compact,
    {},
    () => styles,
    () => ({ t: (text: string) => text }),
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ({
      children,
      accessibilityRole,
      accessibilityLabel,
      onPress,
      style,
    }: {
      children: ReactNode;
      accessibilityRole: string;
      accessibilityLabel: string;
      onPress: () => void;
      style: (state: { pressed: boolean }) => object[];
    }) => {
      const merged = Object.assign({}, ...style({ pressed: false }));
      return (
        <button
          type="button"
          data-role={accessibilityRole}
          aria-label={accessibilityLabel}
          // React Native's paddingHorizontal has no DOM equivalent, so expose it directly.
          data-padding-horizontal={merged.paddingHorizontal}
          onClick={onPress}
          style={merged}
        >
          {children}
        </button>
      );
    },
    ({ children, style }: { children: ReactNode; style: object }) => (
      <span style={style}>{children}</span>
    ),
    ({ ios }: { ios: string }) => <i data-symbol={ios} />,
    { tertiaryLabel: "tertiary" },
    () => ({}),
  ) as (props: { count: number; onPress: () => void }) => ReactNode;

  function render(count: number) {
    const onPress = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<ArchivedChatsRow count={count} onPress={onPress} />));
    return { container, root, onPress };
  }

  it("shows nothing until a chat is archived", () => {
    const { container, root } = render(0);
    expect(container.innerHTML).toBe("");
    act(() => root.unmount());
  });

  it("names the archive with its count and a chevron, and opens it", () => {
    const { container, root, onPress } = render(3);
    const button = container.querySelector("button")!;
    expect(button.getAttribute("data-role")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Archived, 3");
    expect(Array.from(button.querySelectorAll("span"), (span) => span.textContent)).toEqual([
      "Archived",
      "3",
    ]);
    expect(button.querySelectorAll("span")[1]!.style.fontSize).toBe(
      `${styles.sectionCount.fontSize}px`,
    );
    expect(button.querySelector("i")?.getAttribute("data-symbol")).toBe("chevron.right");
    act(() => button.click());
    expect(onPress).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it.each([false, true])(
    "lines up with the section headers and fills a 44pt tap target (compact: %s)",
    (value) => {
      compact = value;
      const { container, root } = render(3);
      const button = container.querySelector("button")!;
      // The same inset as a section header, not the chat-name column past the avatar.
      expect(button.style.paddingInlineStart).toBe("");
      expect(button.getAttribute("data-padding-horizontal")).toBe(
        String(styles.sectionToggle.paddingHorizontal),
      );
      expect(button.style.paddingTop).toBe(`${styles.sectionToggle.paddingTop}px`);
      expect(button.style.minHeight).toBe("44px");
      expect(button.style.width).toBe("100%");
      const label = button.querySelector("span")!;
      expect(label.style.fontSize).toBe(`${styles.sectionTitle.fontSize}px`);
      expect(label.style.fontWeight).toBe(styles.sectionTitle.fontWeight ?? "");
      act(() => root.unmount());
      compact = false;
    },
  );

  it("sits at the very end of the inbox list and opens the existing Archived screen", () => {
    const footer = slice("ListFooterComponent={", "renderItem={renderItem}");
    const row = footer.indexOf("<ArchivedChatsRow");
    expect(row).toBeGreaterThan(footer.indexOf('t("Tap + to create a bot")'));
    expect(footer.slice(row)).toContain('onPress={() => router.push("/archived-bots")}');
    // Nothing but the end of the footer follows the row, however the list is wrapped.
    expect(footer.slice(footer.indexOf("/>", row) + 2).replace(/\s/g, "")).toBe("</>}");
  });
});

describe("archived count", () => {
  const load = vi.fn<typeof loadArchivedChats>();
  const counter = new Function(
    "React",
    "useCallback",
    "useEffect",
    "useRef",
    "useState",
    "useFocusEffect",
    "loadArchivedChats",
    "archivedChatCounts",
    "onArchivedChatsChanged",
    compile(`return function Counter({ me, hasSession }) {
      const [archived, setArchived] = useState({ spaceId: "", count: 0 });
      const archivedCounts = useRef({ spaceId: "", bots: 0, groups: 0 });
      const archivedRequestId = useRef(0);
      ${slice("  const spaceId = me?.spaceId;", "  const loadActivity = useCallback(")}
      return React.createElement("span", null, String(archivedCount));
    };`),
  );

  function setup() {
    // The inbox stays focused here; expo-router reruns the effect when its callback changes.
    const useFocusEffect = (effect: () => (() => void) | undefined) => useEffect(effect, [effect]);
    const Counter = counter(
      React,
      useCallback,
      useEffect,
      useRef,
      useState,
      useFocusEffect,
      load,
      archivedChatCounts,
      onArchivedChatsChanged,
    ) as (props: { me: { spaceId: string } | null; hasSession: boolean }) => ReactNode;
    const container = document.createElement("div");
    const root = createRoot(container);
    const show = async (spaceId: string | null) => {
      await act(async () =>
        root.render(<Counter me={spaceId ? { spaceId } : null} hasSession={spaceId !== null} />),
      );
    };
    return { container, root, show };
  }

  const lists = (bots: number, groups: number) => ({
    bots: Array.from({ length: bots }, () => ({}) as never),
    groups: Array.from({ length: groups }, () => ({}) as never),
    error: undefined,
  });

  beforeEach(() => load.mockReset());

  it("counts archived bots and groups when the inbox is shown, and waits for a session", async () => {
    load.mockResolvedValue(lists(2, 1));
    const h = setup();
    await h.show(null);
    expect(load).not.toHaveBeenCalled();
    await h.show("space-a");
    expect(load).toHaveBeenCalledOnce();
    expect(h.container.textContent).toBe("3");
    act(() => h.root.unmount());
  });

  it("recounts when a chat is archived or restored, without polling", async () => {
    load.mockResolvedValueOnce(lists(0, 0));
    const h = setup();
    await h.show("space-a");
    expect(h.container.textContent).toBe("0");
    load.mockResolvedValueOnce(lists(1, 0));
    await act(async () => notifyArchivedChatsChanged());
    expect(h.container.textContent).toBe("1");
    load.mockResolvedValueOnce(lists(0, 0));
    await act(async () => notifyArchivedChatsChanged());
    expect(h.container.textContent).toBe("0");
    expect(load).toHaveBeenCalledTimes(3);
    act(() => h.root.unmount());
    // An unmounted inbox stops listening.
    await act(async () => notifyArchivedChatsChanged());
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps a list's last count when it fails, but not across spaces", async () => {
    load.mockResolvedValueOnce(lists(2, 1));
    const h = setup();
    await h.show("space-a");
    load.mockResolvedValueOnce({ ...lists(0, 0), bots: null, error: new Error("offline") });
    await act(async () => notifyArchivedChatsChanged());
    expect(h.container.textContent).toBe("2");
    load.mockResolvedValueOnce({ ...lists(0, 0), bots: null, error: new Error("offline") });
    await h.show("space-b");
    expect(h.container.textContent).toBe("0");
    act(() => h.root.unmount());
  });

  it("never shows another space's count while the new space's count is loading", async () => {
    load.mockResolvedValueOnce(lists(2, 1));
    const h = setup();
    await h.show("space-a");
    expect(h.container.textContent).toBe("3");
    let finish!: (value: ReturnType<typeof lists>) => void;
    load.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await h.show("space-b");
    expect(h.container.textContent).toBe("0");
    await act(async () => finish(lists(1, 0)));
    expect(h.container.textContent).toBe("1");
    act(() => h.root.unmount());
  });

  it("shows only the newest count when loads overlap", async () => {
    let finishOld!: (value: ReturnType<typeof lists>) => void;
    load.mockReturnValueOnce(new Promise((resolve) => (finishOld = resolve)));
    const h = setup();
    await h.show("space-a");
    load.mockResolvedValueOnce(lists(1, 0));
    await act(async () => notifyArchivedChatsChanged());
    await act(async () => finishOld(lists(5, 5)));
    expect(h.container.textContent).toBe("1");
    act(() => h.root.unmount());
  });
});

describe("thread menu archive notifications", () => {
  const thread = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
  const actionsSource = thread.slice(
    thread.indexOf("  const botActions = ["),
    thread.indexOf("  function showBotActions()"),
  );

  function setup() {
    const rpc = vi.fn();
    const notify = vi.fn();
    const leave = vi.fn();
    const confirmDeleteBot = vi.fn();
    const alert = vi.fn();
    const actions = new Function(
      "rpc",
      "notifyArchivedChatsChanged",
      "leaveBot",
      "confirmDeleteBot",
      "Alert",
      compile(`
        const readOnly = false, botId = "bot-b", displayName = "Bot";
        const t = text => text, openBotComputer = () => {}, clearConversation = () => {};
        const router = { push() {} }, errorText = () => "failure";
        ${actionsSource}
        return botActions;
      `),
    )(rpc, notify, leave, confirmDeleteBot, { alert }) as { text: string; onPress: () => void }[];
    return { rpc, notify, leave, confirmDeleteBot, alert, actions };
  }

  it("notifies only after archive succeeds, including while the inbox stays mounted", async () => {
    const h = setup();
    let finish!: () => void;
    h.rpc.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    h.actions.find((action) => action.text === "Archive")!.onPress();
    expect(h.notify).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.leave).toHaveBeenCalledOnce();
    h.rpc.mockRejectedValueOnce(new Error("offline"));
    h.actions.find((action) => action.text === "Archive")!.onPress();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.alert).toHaveBeenCalledOnce();
  });

  it("notifies after confirmed deletion succeeds", () => {
    const h = setup();
    h.actions.find((action) => action.text === "Delete…")!.onPress();
    expect(h.notify).not.toHaveBeenCalled();
    h.confirmDeleteBot.mock.calls[0]![1]();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.leave).toHaveBeenCalledOnce();
  });
});

describe("group deletion archive notifications", () => {
  it("notifies after success and leaves the count unchanged on failure", async () => {
    const group = readFileSync(new URL("../app/group-settings.tsx", testFileUrl), "utf8");
    const rpc = groupRpc.mockReset().mockResolvedValueOnce({});
    const notify = vi.fn();
    const alert = groupAlert.mockReset();
    const remove = new Function(
      "confirmDeleteGroup",
      "notifyArchivedChatsChanged",
      compile(`
      const groupId = "group-b", group = { name: "Group" };
      const router = { replace() {} };
      ${group.slice(group.indexOf("  function remove()"), group.indexOf("  return ("))}
      return remove;
    `),
    )(confirmDeleteGroup, notify);
    remove();
    alert.mock.calls[0]![2][1].onPress();
    expect(notify).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledOnce();
    rpc.mockRejectedValueOnce(new Error("offline"));
    remove();
    alert.mock.calls[1]![2][1].onPress();
    await Promise.resolve();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledOnce();
  });
});
