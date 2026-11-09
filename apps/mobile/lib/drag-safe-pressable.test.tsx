// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { GestureResponderEvent, PressableProps } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DragSafePressable } from "../components/drag-safe-pressable";

const pressable = vi.hoisted(() => ({ props: null as PressableProps | null }));

vi.mock("react-native", () => ({
  Pressable: (props: PressableProps) => {
    pressable.props = props;
    return null;
  },
}));

const at = (pageX: number, pageY: number) =>
  ({ nativeEvent: { pageX, pageY } }) as GestureResponderEvent;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

function render(onPress: () => void) {
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<DragSafePressable onPress={onPress} />));
  return { props: pressable.props!, root };
}

it("presses on a tap and not on a release after the finger travelled, as when it scrolled", () => {
  const onPress = vi.fn();
  const { props, root } = render(onPress);
  // A tap moves a little at most.
  props.onPressIn?.(at(100, 200));
  props.onPress?.(at(104, 206));
  expect(onPress).toHaveBeenCalledTimes(1);
  // A drag that scrolled the list releases far from where it started.
  props.onPressIn?.(at(100, 200));
  props.onPress?.(at(100, 450));
  expect(onPress).toHaveBeenCalledTimes(1);
  // Nor after one that scrolled away and came back near where it started.
  act(() => {
    props.onPressIn?.(at(100, 200));
    props.onTouchMove?.(at(100, 320));
    props.onPress?.(at(101, 203));
  });
  expect(onPress).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

it("still presses when activated without a touch, as by VoiceOver", () => {
  const onPress = vi.fn();
  const { props, root } = render(onPress);
  props.onPress?.(at(0, 0));
  expect(onPress).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

it("keeps no press area of its own, so a mismeasured row does not drop the tap", () => {
  const { props, root } = render(vi.fn());
  const area = props.pressRetentionOffset as { top: number; bottom: number };
  expect(area.top).toBeGreaterThan(10_000);
  expect(area.bottom).toBeGreaterThan(10_000);
  act(() => root.unmount());
});
