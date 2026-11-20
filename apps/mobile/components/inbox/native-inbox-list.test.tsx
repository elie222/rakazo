// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeListRowContext } from "../native/native-list-row";
import type { OpenSwipe } from "./inbox-swipe-context";
import { InboxSwipeContext } from "./inbox-swipe-context";
import { NativeInboxList } from "./native-inbox-list.ios";

type Modifier = { name: string; value: unknown };

const swift = vi.hoisted(() => ({
  geometry: [] as Array<(frame: { width: number }) => void>,
  openSwipe: null as { current: OpenSwipe | null } | null,
  scrolls: [] as Array<[number | null, number]>,
  overlay: null as null | {
    pills: { above?: { index: number }; below?: { index: number } };
    onJump: (direction: "above" | "below", pill: { index: number }) => void;
  },
}));

// Tests load the shared module; the list rows are the iOS one.
vi.mock("../native/native-row", () => import("../native/native-row.ios"));
vi.mock("@expo/ui/swift-ui", () => {
  const box =
    (name: string) =>
    ({ children, modifiers }: { children?: ReactNode; modifiers?: Modifier[] }) => (
      <div
        data-ui={name}
        data-modifiers={(modifiers ?? []).map((modifier) => modifier.name).join(" ")}
      >
        {children}
      </div>
    );
  return {
    Group: box("Group"),
    Host: box("Host"),
    List: box("List"),
    RNHostView: box("RNHostView"),
    Rectangle: box("Rectangle"),
    Spacer: box("Spacer"),
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = (name: string) => (value: unknown) => {
    if (name === "onGeometryChange")
      swift.geometry.push(value as (frame: { width: number }) => void);
    return { name, value };
  };
  return Object.fromEntries(
    [
      "foregroundStyle",
      "frame",
      "ignoreSafeArea",
      "listRowBackground",
      "listRowInsets",
      "listRowSeparator",
      "listSectionMargins",
      "listStyle",
      "onAppear",
      "onDisappear",
      "onGeometryChange",
      "onScrollPhaseChange",
      "refreshable",
      "scrollContentBackground",
    ].map((name) => [name, modifier(name)]),
  );
});
vi.mock("react-native", () => ({
  findNodeHandle: () => 1,
  View: ({ children, style }: { children?: ReactNode; style?: { width?: number } }) => (
    <div data-ui="View" data-width={style?.width}>
      {children}
    </div>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../lib/layout/floating-header", () => ({
  useFloatingHeaderInset: () => 0,
  useTopBarInset: () => 0,
}));
vi.mock("../../lib/native/native", () => ({
  native: { page: "page" },
  useResolvedAppearance: () => "light",
}));
vi.mock("../../lib/native/native-controls", () => ({ iosAtLeast: () => true }));
vi.mock("../../lib/native/native-list-scroll", () => ({
  canScrollNativeList: true,
  scrollNativeListToRow: (tag: number | null, row: number) => {
    swift.scrolls.push([tag, row]);
    return Promise.resolve(true);
  },
}));
vi.mock("./unread-jump-overlay", () => ({
  UnreadJumpOverlay: (props: NonNullable<typeof swift.overlay>) => {
    swift.overlay = props;
    return null;
  },
}));

type Item = { key: string; swipe: boolean };

/** A chat row as the native list sees it: it reads the row context the list gives it. */
function Row({ item }: { item: Item }) {
  const row = useContext(NativeListRowContext);
  swift.openSwipe = useContext(InboxSwipeContext);
  return (
    <span
      data-row={item.key}
      data-native={
        row ? row.modifiers.map((modifier) => (modifier as unknown as Modifier).name).join(" ") : ""
      }
      data-width={row?.width}
    />
  );
}

let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  swift.geometry = [];
  container = document.createElement("div");
});
afterEach(() => vi.unstubAllGlobals());

function render(
  data: Item[],
  extra: {
    empty?: ReactNode;
    header?: ReactNode;
    signals?: Array<{ unread: number; attention: number }>;
    viewport?: { update: () => void; subscribe: () => () => void; has: (key: string) => boolean };
    width?: number;
  } = {},
) {
  const root = createRoot(container);
  act(() =>
    root.render(
      <NativeInboxList<Item>
        data={data}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <Row item={item} />}
        isNativeRow={(item) => item.swipe}
        header={extra.header}
        empty={extra.empty}
        footer={<span data-footer />}
        gutters={{ left: 8, right: 8 }}
        column={{ left: 8, right: 8 }}
        width={extra.width ?? 378}
        avatarViewport={
          (extra.viewport ?? {
            update: vi.fn(),
            subscribe: () => () => {},
            has: () => false,
          }) as never
        }
        onRefresh={async () => undefined}
        signals={extra.signals ?? []}
        showJumpPills={extra.signals !== undefined}
      />,
    ),
  );
  // The list draws rows once it has measured the width a row gets.
  act(() => swift.geometry.at(-1)?.({ width: 362 }));
  return root;
}

it("puts chat rows in the list as rows and hosts every other row's content", () => {
  const root = render([
    { key: "heading:work", swipe: false },
    { key: "bot:1", swipe: true },
  ]);
  // A chat row joins the list itself, with the list's row modifiers.
  const chat = container.querySelector<HTMLElement>('[data-row="bot:1"]')!;
  expect(chat.dataset.native).toBe(
    "listRowInsets listRowSeparator listRowBackground onAppear onDisappear",
  );
  expect(chat.closest('[data-ui="RNHostView"]')).toBeNull();
  // A heading is React Native content in a hosted row, outside any row context.
  const heading = container.querySelector<HTMLElement>('[data-row="heading:work"]')!;
  expect(heading.dataset.native).toBe("");
  expect(heading.closest('[data-ui="Group"]')?.getAttribute("data-modifiers")).toBe(
    "listRowInsets listRowSeparator listRowBackground onAppear onDisappear",
  );
  expect(container.querySelector("[data-footer]")).not.toBeNull();
  act(() => root.unmount());
});

it("gives hosted content the row width the list measures", () => {
  const root = render([
    { key: "heading:work", swipe: false },
    { key: "bot:1", swipe: true },
  ]);
  expect(container.querySelector<HTMLElement>('[data-row="bot:1"]')?.dataset.width).toBe("362");
  const heading = container.querySelector('[data-row="heading:work"]')!;
  expect(heading.closest('[data-ui="View"]')?.getAttribute("data-width")).toBe("362");
  act(() => root.unmount());
});

it("follows a resize once the measured spacer has scrolled out of view", () => {
  const props = {
    data: [{ key: "bot:1", swipe: true }],
    keyExtractor: (item: Item) => item.key,
    renderItem: ({ item }: { item: Item }) => <Row item={item} />,
    isNativeRow: (item: Item) => item.swipe,
    gutters: { left: 8, right: 8 },
    column: { left: 8, right: 8 },
    avatarViewport: { update: vi.fn(), subscribe: () => () => {}, has: () => false } as never,
    onRefresh: async () => undefined,
    signals: [],
    showJumpPills: false,
  };
  const root = createRoot(container);
  act(() => root.render(<NativeInboxList<Item> {...props} width={378} />));
  act(() => swift.geometry.at(-1)?.({ width: 362 }));
  // The divider is dragged wider while the spacer is off screen, so it reports nothing.
  act(() => root.render(<NativeInboxList<Item> {...props} width={578} />));
  expect(container.querySelector<HTMLElement>('[data-row="bot:1"]')?.dataset.width).toBe("562");
  act(() => root.unmount());
});

it("shows the empty state only while there are no rows", () => {
  const root = render([], { empty: <span data-empty /> });
  expect(container.querySelector("[data-empty]")).not.toBeNull();
  act(() => root.unmount());
  const again = render([{ key: "bot:1", swipe: true }], { empty: <span data-empty /> });
  expect(container.querySelector("[data-empty]")).toBeNull();
  act(() => again.unmount());
});

it("dismisses the open swipe before jumping to an unread row", () => {
  swift.scrolls = [];
  const read = { unread: 0, attention: 0 };
  const root = render(
    [
      { key: "bot:1", swipe: true },
      { key: "bot:2", swipe: true },
      { key: "bot:3", swipe: true },
    ],
    {
      header: <span data-header />,
      signals: [read, read, { unread: 1, attention: 0 }],
      // Only the first chat is on screen.
      viewport: { update: vi.fn(), subscribe: () => () => {}, has: (key) => key === "bot:1" },
    },
  );
  const below = swift.overlay?.pills.below;
  expect(below?.index).toBe(2);
  const close = vi.fn(() => {
    expect(swift.scrolls).toEqual([]);
  });
  swift.openSwipe!.current = { id: "swiped", close };
  act(() => swift.overlay?.onJump("below", below!));
  expect(close).toHaveBeenCalledOnce();
  // The header row comes first in the list, so the third chat is its fourth row.
  expect(swift.scrolls).toEqual([[1, 3]]);
  act(() => root.unmount());
});

it("draws no rows until it knows a row's width, so none keeps a wrong first layout", () => {
  const root = createRoot(container);
  act(() =>
    root.render(
      <NativeInboxList<Item>
        data={[{ key: "bot:1", swipe: true }]}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <Row item={item} />}
        isNativeRow={(item) => item.swipe}
        gutters={{ left: 0, right: 0 }}
        column={{ left: 0, right: 0 }}
        width={362}
        avatarViewport={{ update: vi.fn(), subscribe: () => () => {}, has: () => false } as never}
        onRefresh={async () => undefined}
        signals={[]}
        showJumpPills={false}
      />,
    ),
  );
  expect(container.querySelector('[data-row="bot:1"]')).toBeNull();
  act(() => swift.geometry.at(-1)?.({ width: 362 }));
  expect(container.querySelector('[data-row="bot:1"]')).not.toBeNull();
  act(() => root.unmount());
});

it("counts every chat as below while only the rows above the chats are on screen", () => {
  const read = { unread: 0, attention: 0 };
  const root = render(
    [
      { key: "bot:1", swipe: true },
      { key: "bot:2", swipe: true },
    ],
    {
      header: <span data-header />,
      signals: [read, { unread: 1, attention: 0 }],
      // A tall activity strip fills the screen.
      viewport: { update: vi.fn(), subscribe: () => () => {}, has: (key) => key === "header" },
    },
  );
  expect(swift.overlay?.pills.below?.index).toBe(1);
  act(() => root.unmount());
});

it("keeps the same native list when the pills hide, as during a refresh", () => {
  const props = {
    data: [{ key: "bot:1", swipe: true }],
    keyExtractor: (item: Item) => item.key,
    renderItem: ({ item }: { item: Item }) => <Row item={item} />,
    isNativeRow: (item: Item) => item.swipe,
    gutters: { left: 0, right: 0 },
    column: { left: 0, right: 0 },
    width: 362,
    avatarViewport: { update: vi.fn(), subscribe: () => () => {}, has: () => false } as never,
    onRefresh: async () => undefined,
    signals: [{ unread: 0, attention: 0 }],
  };
  const root = createRoot(container);
  act(() => root.render(<NativeInboxList<Item> {...props} showJumpPills />));
  act(() => swift.geometry.at(-1)?.({ width: 362 }));
  const host = container.querySelector('[data-ui="Host"]');
  act(() => root.render(<NativeInboxList<Item> {...props} showJumpPills={false} />));
  expect(container.querySelector('[data-ui="Host"]')).toBe(host);
  act(() => root.unmount());
});
