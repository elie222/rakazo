import { useRef } from "react";
import type { GestureResponderEvent, PressableProps } from "react-native";
import { Pressable } from "react-native";

/** How far, in points, a finger may travel between press-in and release for it to be a tap. */
export const TAP_SLOP = 10;

// The finger's travel decides, so the press keeps no area of its own. Inside a native list the
// row's measured position can be off (beside a split view's header), which would otherwise
// count a release on the row as outside it and drop the tap.
const ANYWHERE = { top: 100_000, bottom: 100_000, left: 100_000, right: 100_000 };

/**
 * A Pressable that ignores a release after the finger travelled, as when it scrolled the list.
 * Inside a native iOS list a scroll does not cancel a React Native press: the content moves with
 * the finger, so the release still lands on the row that was touched and would open it.
 */
export function DragSafePressable({ onPressIn, onPress, ...props }: PressableProps) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return (
    <Pressable
      pressRetentionOffset={ANYWHERE}
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
