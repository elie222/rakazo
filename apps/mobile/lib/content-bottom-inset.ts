import { useContext } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CallKeyboardContext } from "./call-keyboard-context";

export function useContentBottomInset(): number {
  const rootOwnsBottom = useContext(CallKeyboardContext);
  const insets = useSafeAreaInsets();
  return rootOwnsBottom ? 0 : insets.bottom;
}

/**
 * How far a floating bar sits above the screen's bottom edge: always a gap above the system's
 * own bottom area, so it never rests flush on Android's three-button navigation bar, whose
 * whole height is the inset, nor on a bare edge.
 */
export function floatingBarBottom(bottomInset: number): number {
  return Math.max(bottomInset + 12, 16);
}
