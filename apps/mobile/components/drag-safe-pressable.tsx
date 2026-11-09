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
export function DragSafePressable({ onPressIn, onPress, onTouchMove, ...props }: PressableProps) {
  // Where the press started, and whether the finger has since gone further than a tap allows.
  const press = useRef<{ x: number; y: number; travelled: boolean } | null>(null);
  const beyondSlop = (event: GestureResponderEvent) => {
    const from = press.current;
    return (
      !!from &&
      Math.hypot(event.nativeEvent.pageX - from.x, event.nativeEvent.pageY - from.y) > TAP_SLOP
    );
  };
  return (
    <Pressable
      pressRetentionOffset={ANYWHERE}
      {...props}
      onPressIn={(event: GestureResponderEvent) => {
        press.current = {
          x: event.nativeEvent.pageX,
          y: event.nativeEvent.pageY,
          travelled: false,
        };
        onPressIn?.(event);
      }}
      // A scroll that comes back near where it started still travelled.
      onTouchMove={(event) => {
        if (press.current && beyondSlop(event)) press.current.travelled = true;
        onTouchMove?.(event);
      }}
      onPress={
        onPress
          ? (event: GestureResponderEvent) => {
              const travelled = press.current?.travelled || beyondSlop(event);
              press.current = null;
              if (!travelled) onPress(event);
            }
          : undefined
      }
    />
  );
}
