// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useInlineInputFocus } from "../../lib/thread/inline-input-focus";
import { threadColumnPadding } from "../../lib/thread/scroll/thread-edges";
import type { ThreadListScroll } from "../../lib/thread/scroll/thread-list-scroll";
import { ThreadMessageList } from "./thread-message-list";

const native = vi.hoisted(() => ({
  os: "ios",
  flat: null as Record<string, unknown> | null,
  scroll: null as Record<string, unknown> | null,
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    ActivityIndicator: () => null,
    FlatList: (props: Record<string, unknown> & { ListHeaderComponent?: ReactNode }) => {
      native.flat = props;
      return createElement("div", { "data-list": "flat" }, props.ListHeaderComponent);
    },
    Platform: {
      get OS() {
        return native.os;
      },
    },
    ScrollView: (props: Record<string, unknown> & { children?: ReactNode }) => {
      native.scroll = props;
      return createElement("div", { "data-list": "scroll" }, props.children);
    },
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  };
});

vi.mock("@rakazo/core", () => ({
  threadWindowMessages: (messages: unknown[]) => messages,
}));

vi.mock("./thread-scroll-surface", () => ({
  ThreadScrollSurface: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./thread-list-controls", () => ({
  JumpToLatestButton: ({ insetEnd }: { insetEnd: number }) =>
    createElement("div", { "data-inset-end": String(insetEnd) }),
}));

vi.mock("../../lib/appearance/appearance", () => ({
  mobileTokens: () => ({ mutedForeground: "muted" }),
}));

type ListProps = ComponentProps<typeof ThreadMessageList>;

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return (style as Record<string, unknown>) ?? {};
}

function scroll(overrides: { showPinnedPage?: boolean; detached?: boolean } = {}) {
  return {
    helperViewport: { current: null },
    pinnedList: { current: null },
    list: { current: null },
    showPinnedPage: overrides.showPinnedPage ?? false,
    pinnedTarget: null,
    pinnedNewerCursor: null,
    behavior: { current: { onLayout: () => undefined, jumpToLatest: () => undefined } },
    state: { detached: overrides.detached ?? false, unread: false },
    jumpTarget: null,
    performScroll: () => undefined,
    follow: () => undefined,
    liveListHandlers: {},
  } as unknown as ThreadListScroll;
}

function listProps(
  overrides: Partial<ListProps> & { showPinnedPage?: boolean; detached?: boolean } = {},
): ListProps {
  const { showPinnedPage, detached, ...rest } = overrides;
  return {
    scroll: scroll({ showPinnedPage, detached }),
    pinnedListHandlers: {} as ListProps["pinnedListHandlers"],
    threadKey: "thread-1",
    headerClearance: { padding: 80, minHeight: 80 },
    bottomInset: 0,
    columnPadding: threadColumnPadding({ left: 40, right: 8 }, false),
    visibleMessages: [],
    liveItems: [],
    renderItem: () => null,
    renderMessageRow: () => createElement("div"),
    loadEarlierControl: null,
    failedSendBubbles: null,
    errorNotice: null,
    workingFooter: null,
    loadingNewer: false,
    showLatest: () => undefined,
    ...rest,
  };
}

let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.os = "ios";
  native.flat = null;
  native.scroll = null;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
});

it("pads message content and leaves the live list frame on the screen edge", async () => {
  const root = createRoot(container);
  await act(async () => root.render(createElement(ThreadMessageList, listProps())));
  const frame = flatten(native.flat?.style);
  const content = flatten(native.flat?.contentContainerStyle);
  expect(frame).toEqual({ flex: 1 });
  expect(content).toMatchObject({ paddingStart: 60, paddingEnd: 28, paddingBottom: 80 });
  expect(native.flat?.keyboardShouldPersistTaps).toBeUndefined();
  await act(async () => root.unmount());
});

it("pads a pinned page the same way and keeps the jump button on the column edge", async () => {
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(ThreadMessageList, listProps({ showPinnedPage: true }))),
  );
  const frame = flatten(native.scroll?.style);
  const content = flatten(native.scroll?.contentContainerStyle);
  expect(frame).toEqual({ flex: 1 });
  expect(content).toMatchObject({ paddingStart: 60, paddingEnd: 28, paddingTop: 80 });
  expect(native.scroll?.keyboardShouldPersistTaps).toBeUndefined();
  expect(container.querySelector("[data-inset-end]")?.getAttribute("data-inset-end")).toBe("28");
  await act(async () => root.unmount());
});

it("persists taps only while an inline card input owns focus", async () => {
  let setFocus: ((focused: boolean) => void) | undefined;
  function Probe() {
    setFocus = useInlineInputFocus();
    return null;
  }
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ThreadMessageList, listProps({ workingFooter: createElement(Probe) })),
    ),
  );
  expect(native.flat?.keyboardShouldPersistTaps).toBeUndefined();

  await act(async () => setFocus?.(true));
  expect(native.flat?.keyboardShouldPersistTaps).toBe("handled");

  await act(async () =>
    root.render(
      createElement(
        ThreadMessageList,
        listProps({ showPinnedPage: true, workingFooter: createElement(Probe) }),
      ),
    ),
  );
  expect(native.scroll?.keyboardShouldPersistTaps).toBe("handled");

  await act(async () => setFocus?.(false));
  expect(native.scroll?.keyboardShouldPersistTaps).toBeUndefined();
  await act(async () => root.unmount());
});

it("swaps the live list's side padding for Android's mirrored inverted list only", async () => {
  native.os = "android";
  const root = createRoot(container);
  await act(async () => root.render(createElement(ThreadMessageList, listProps())));
  const live = flatten(native.flat?.contentContainerStyle);
  expect(live).toMatchObject({ paddingStart: 28, paddingEnd: 60 });
  await act(async () =>
    root.render(createElement(ThreadMessageList, listProps({ showPinnedPage: true }))),
  );
  const pinned = flatten(native.scroll?.contentContainerStyle);
  expect(pinned).toMatchObject({ paddingStart: 60, paddingEnd: 28 });
  await act(async () => root.unmount());
});
