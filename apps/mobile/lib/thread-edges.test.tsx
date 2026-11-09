import { createElement } from "react";
import { Platform } from "react-native";
import { ScrollViewMarker } from "react-native-screens/experimental";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadScrollSurface } from "../components/thread-scroll-surface";
import {
  threadColumnPadding,
  threadEdgeOptions,
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

it("pads the chat column inside the screen, including a cutout and a wide gutter", () => {
  expect(threadColumnPadding({ left: 0, right: 0 }, false)).toEqual({
    paddingStart: 20,
    paddingEnd: 20,
  });
  expect(threadColumnPadding({ left: 40, right: 8 }, false)).toEqual({
    paddingStart: 60,
    paddingEnd: 28,
  });
});

it("keeps a physical cutout on its own side when the layout is right to left", () => {
  // In RTL, start is the right edge and end (where the jump button sits) is the left edge.
  expect(threadColumnPadding({ left: 40, right: 8 }, true)).toEqual({
    paddingStart: 28,
    paddingEnd: 60,
  });
});
