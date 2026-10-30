import { createElement } from "react";
import { Platform } from "react-native";
import { ScrollViewMarker } from "react-native-screens/experimental";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadScrollSurface } from "../components/thread-scroll-surface";
import {
  THREAD_COLUMN_GUTTER,
  threadColumnPadding,
  threadColumnTrailingInset,
  threadEdgeOptions,
  threadHeaderClearance,
  threadHeaderFloats,
  threadScrollEdgeEffects,
} from "./thread-edges";

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: 26 } }));
vi.mock("react-native-screens/experimental", () => ({ ScrollViewMarker: () => null }));

afterEach(() => {
  Platform.OS = "ios";
  Platform.Version = 26;
});

describe("thread scroll edges", () => {
  it("hides all four edges while keeping the iOS 26 header transparent", () => {
    expect(threadEdgeOptions()).toEqual({
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      headerShadowVisible: false,
      scrollEdgeEffects: { top: "hidden", bottom: "hidden", left: "hidden", right: "hidden" },
    });
    const child = createElement("scroll-view");
    const surface = ThreadScrollSurface({ children: child });
    expect(surface.type).toBe(ScrollViewMarker);
    expect(surface.props).toEqual({
      style: { flex: 1 },
      scrollEdgeEffects: threadScrollEdgeEffects,
      children: child,
    });
  });

  it.each(["18.5", 25, 26, "26.1"])("floats the header on iOS %s", (version) => {
    Platform.Version = version;
    expect(threadHeaderFloats()).toBe(true);
    expect(threadEdgeOptions()).toEqual({
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      headerShadowVisible: false,
      scrollEdgeEffects: threadScrollEdgeEffects,
    });
    const child = createElement("scroll-view");
    if (Number.parseFloat(String(version)) < 26) {
      expect(ThreadScrollSurface({ children: child })).toBe(child);
    }
  });

  it("preserves the Android tree and header", () => {
    Platform.OS = "android";
    const child = createElement("scroll-view");
    expect(ThreadScrollSurface({ children: child })).toBe(child);
    expect(threadHeaderFloats()).toBe(false);
    expect(threadEdgeOptions()).toEqual({
      headerTransparent: false,
      scrollEdgeEffects: threadScrollEdgeEffects,
    });
  });
});

it.each([64, 96, 116, 120])(
  "rests content and jump targets below the pills at header height %s",
  (height) => {
    const clearance = threadHeaderClearance(height);
    const pillBottom = height - 10;
    expect(clearance.padding - pillBottom).toBe(14);
    expect(clearance.minHeight).toBe(clearance.padding);
    expect(clearance.anchor).toBe(clearance.padding + 20);
    // The first date has a 12pt margin and about 4pt of font leading.
    expect(clearance.padding + 16 - pillBottom).toBe(30);
  },
);

it("preserves Android clearance without a floating header", () => {
  expect(threadHeaderClearance(0)).toEqual({ padding: 8, anchor: 24, minHeight: 0 });
});

it("pads the chat column inside the screen, including a cutout and a wide gutter", () => {
  expect(THREAD_COLUMN_GUTTER).toBe(20);
  expect(threadColumnPadding({ left: 0, right: 0 })).toEqual({
    paddingLeft: 20,
    paddingRight: 20,
  });
  expect(threadColumnPadding({ left: 40, right: 8 })).toEqual({
    paddingLeft: 60,
    paddingRight: 28,
  });
});

it("keeps the jump button on the column's trailing edge in both directions", () => {
  const padding = threadColumnPadding({ left: 40, right: 8 });
  expect(threadColumnTrailingInset(padding, false)).toBe(28);
  expect(threadColumnTrailingInset(padding, true)).toBe(60);
});
