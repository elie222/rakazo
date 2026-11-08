import { useRef } from "react";
import type { GestureResponderEvent, PressableProps } from "react-native";
import { Pressable } from "react-native";

/** How far, in points, a finger may travel between press-in and release for it to be a tap. */
export const TAP_SLOP = 10;

/**
 * A Pressable that ignores a release after the finger travelled, as when it scrolled the list.
 * Inside a native iOS list a scroll does not cancel a React Native press: the content moves with
 * the finger, so the release still lands on the row that was touched and would open it.
 */
export function DragSafePressable({ onPressIn, onPress, ...props }: PressableProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return (
    <Pressable
      {...props}
      onPressIn={(event: GestureResponderEvent) => {
        start.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
        onPressIn?.(event);
      }}
      onPress={
        onPress
          ? (event: GestureResponderEvent) => {
              const from = start.current;
              start.current = null;
              const travel = from
                ? Math.hypot(event.nativeEvent.pageX - from.x, event.nativeEvent.pageY - from.y)
                : 0;
              if (travel <= TAP_SLOP) onPress(event);
            }
          : undefined
      }
    />
  );
}
