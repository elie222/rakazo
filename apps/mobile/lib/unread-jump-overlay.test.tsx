// @vitest-environment jsdom

import type { ReactElement, ReactNode } from "react";
import { act, createContext, createElement, useContext, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ context: undefined as unknown }));

vi.mock("expo-router/react-navigation", () => {
  navigation.context = createContext<number | undefined>(undefined);
  return {
    HeaderHeightContext: navigation.context,
    useHeaderHeight: () => {
      const height = useContext(navigation.context as React.Context<number | undefined>);
      if (height === undefined) throw new Error("Couldn't find the header height.");
      return height;
    },
  };
});
vi.mock("./native-controls", () => ({ iosAtLeast: () => true }));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: (props: { children?: ReactNode }) => createElement("div", null, props.children),
}));
vi.mock("react-native-reanimated", () => ({
  default: {
    View: (props: { children?: ReactNode }) => createElement("div", null, props.children),
  },
  FadeIn: { duration: () => ({ reduceMotion: () => "fade-in" }) },
  FadeOut: { duration: () => ({ reduceMotion: () => "fade-out" }) },
  ReduceMotion: { System: "system" },
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string | number>) =>
      text
        .replace("{count}", String(values?.count ?? ""))
        .replace("{label}", String(values?.label ?? "")),
  }),
}));
vi.mock("../components/unread-jump-pill", () => ({
  UNREAD_JUMP_PILL_HEIGHT: 38,
  UnreadJumpPill: () => null,
}));

import { useUnreadJumpPills } from "../components/unread-jump-overlay";
import { useHeaderHeightIfAny } from "./floating-header";

type Pills = ReturnType<typeof useUnreadJumpPills<unknown>>;
type Signal = { unread: number; attention: number };

const read = { unread: 0, attention: 0 };
const unread = { unread: 1, attention: 0 };
const PILL_SPACE = 8 + 38 + 8;

describe("useHeaderHeightIfAny", () => {
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("is 0 outside a stack screen, like the inbox beside a chat, and the header height inside one", () => {
    const seen: number[] = [];
    function Probe() {
      seen.push(useHeaderHeightIfAny());
      return null;
    }
    const Context = navigation.context as React.Context<number | undefined>;
    act(() => root.render(createElement(Probe)));
    act(() => root.render(createElement(Context.Provider, { value: 101 }, createElement(Probe))));
    expect(seen).toEqual([0, 101]);
  });
});

describe("useUnreadJumpPills", () => {
  let root: Root;
  let pills: Pills;
  const scrollToOffset = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
    scrollToOffset.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  function Harness({ keys, signals }: { keys: string[]; signals: Signal[] }) {
    const listRef = useRef({ scrollToOffset } as never);
    pills = useUnreadJumpPills({ keys, signals, listRef, topInset: 0, bottomInset: 0 });
    return null;
  }
  const render = (keys: string[], signals: Signal[]) =>
    act(() => root.render(createElement(Harness, { keys, signals })));
  const viewport = (height: number, content: number) =>
    act(() => {
      pills.listProps.onLayout({ nativeEvent: { layout: { height } } } as never);
      pills.listProps.onContentSizeChange(0, content);
    });
  const layOut = (key: string, y: number, height = 100) =>
    act(() => {
      const cell = pills.listProps.CellRendererComponent({
        cellKey: key,
        index: 0,
        item: null,
        style: undefined,
        children: null,
      }) as ReactElement<{ onLayout: (event: unknown) => void }>;
      cell.props.onLayout({ nativeEvent: { layout: { y, height } } });
    });
  const edgeAt = (index: number) => {
    const edge = (pills.overlay as ReactElement<{ children: ReactElement[] }>).props.children[
      index
    ];
    return edge as ReactElement<{
      entering?: unknown;
      exiting?: unknown;
      children: ReactElement<{ onPress: () => void; label: string; accessibilityLabel: string }>;
    }> | null;
  };
  const below = () => edgeAt(1);

  it("names the direction and skips only the first measured entrance", () => {
    render(["a", "b", "c"], [unread, read, unread]);
    layOut("a", 0);
    layOut("b", 100);
    viewport(100, 300);
    expect(below()?.props.children.props.accessibilityLabel).toBe("1 unread, below");
    expect(below()?.props.entering).toBeUndefined();
    expect(below()?.props.exiting).toBe("fade-out");
    act(() =>
      pills.listProps.onScroll({
        nativeEvent: {
          contentOffset: { y: 100 },
          layoutMeasurement: { height: 100 },
          contentSize: { height: 300 },
        },
      } as never),
    );
    const above = edgeAt(0);
    expect(above?.props.children.props.accessibilityLabel).toBe("1 unread, above");
    expect(above?.props.entering).toBe("fade-in");
    render(["a", "b", "c"], [unread, read, { unread: 0, attention: 1 }]);
    expect(below()?.props.children.props.accessibilityLabel).toBe("Needs attention, below");
    render(["a", "b", "c"], [unread, read, { unread: 0, attention: 2 }]);
    expect(below()?.props.children.props.accessibilityLabel).toBe("2 need attention, below");
  });

  it("keeps each row's layout by key when rows above it go away", () => {
    render(["a", "b", "c"], [read, read, unread]);
    layOut("a", 0);
    layOut("b", 100);
    layOut("c", 200);
    viewport(200, 300);
    expect(below()?.props.children.props.label).toBe("1 unread");
    // "a" collapses. "b" reports where it moved to; "c" hasn't yet, so it still counts below.
    render(["b", "c"], [read, unread]);
    layOut("b", 0);
    expect(below()?.props.children.props.label).toBe("1 unread");
    // Once "c" reports too, it's on screen and the pill goes.
    layOut("c", 100);
    expect(below()).toBeFalsy();
  });

  it("doesn't jump to where a moved row used to be before it lays out again", () => {
    const keys = ["s1", "s2", "x", "y", "z", "w"];
    render(keys, [read, read, read, read, unread, read]);
    for (const [index, key] of keys.entries()) layOut(key, index * 100);
    viewport(100, 600);
    // A section with s1 and s2 collapses; z is now 200 higher, but far rows don't re-report.
    render(["x", "y", "z", "w"], [read, read, unread, read]);
    layOut("x", 0);
    layOut("y", 100);
    viewport(100, 400);
    act(() => below()?.props.children.props.onPress());
    expect(scrollToOffset.mock.lastCall?.[0].offset).toBeLessThan(400 - PILL_SPACE);
    layOut("z", 200);
    expect(scrollToOffset.mock.lastCall).toEqual([{ offset: 200 - PILL_SPACE }]);
  });

  it("scrolls toward an unmeasured row, then lands on it once it lays out", () => {
    const keys = Array.from({ length: 30 }, (_, index) => `row-${index}`);
    render(
      keys,
      keys.map((_, index) => (index === 20 ? unread : read)),
    );
    layOut("row-0", 0);
    layOut("row-1", 100);
    layOut("row-2", 200);
    viewport(300, 3000);
    act(() => below()?.props.children.props.onPress());
    // Rows average 100pt, so row 20 is estimated at 2000, under the upper pill's space.
    expect(scrollToOffset.mock.calls).toEqual([[{ offset: 2000 - PILL_SPACE }]]);
    layOut("row-20", 2400);
    expect(scrollToOffset.mock.calls).toEqual([
      [{ offset: 2000 - PILL_SPACE }],
      [{ offset: 2400 - PILL_SPACE }],
    ]);
  });

  it("hides pills during top overscroll and restores them at rest", () => {
    render(["a", "b", "c"], [read, read, unread]);
    layOut("a", 0);
    layOut("b", 100);
    viewport(200, 300);
    const scroll = (y: number) =>
      act(() =>
        pills.listProps.onScroll({
          nativeEvent: {
            contentOffset: { y },
            layoutMeasurement: { height: 200 },
            contentSize: { height: 300 },
          },
        } as never),
      );
    expect(below()).not.toBeNull();
    scroll(-20);
    expect(below()).toBeNull();
    scroll(0);
    expect(below()).not.toBeNull();
  });

  it("cancels a pending jump when the user drags", () => {
    render(["a", "b", "c"], [read, read, unread]);
    layOut("a", 0);
    viewport(100, 300);
    act(() => below()?.props.children.props.onPress());
    act(() => pills.listProps.onScrollBeginDrag());
    layOut("c", 200);
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
  });

  it("lands on a far row while the list's content size is still a short estimate", () => {
    const keys = Array.from({ length: 30 }, (_, index) => `row-${index}`);
    render(
      keys,
      keys.map((_, index) => (index === 20 ? unread : read)),
    );
    layOut("row-0", 0);
    // The list reports less content than there is: the rows below aren't rendered yet.
    viewport(300, 2300);
    act(() => below()?.props.children.props.onPress());
    layOut("row-20", 2400);
    expect(scrollToOffset.mock.lastCall).toEqual([{ offset: 2400 - PILL_SPACE }]);
    // It keeps correcting as rows settle, until the user scrolls.
    layOut("row-20", 2380);
    expect(scrollToOffset.mock.lastCall).toEqual([{ offset: 2380 - PILL_SPACE }]);
    const calls = scrollToOffset.mock.calls.length;
    act(() => pills.listProps.onScrollBeginDrag());
    layOut("row-20", 2360);
    expect(scrollToOffset.mock.calls).toHaveLength(calls);
  });
});
