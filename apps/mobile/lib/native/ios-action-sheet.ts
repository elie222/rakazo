// biome-ignore lint/correctness/useReactNativePlatformComponents: a type, erased from the bundle.
import type { ActionSheetIOSOptions } from "react-native";

// The native sheet lives in ios-action-sheet.ios.ts; callers check Platform.OS first.
export function showIOSActionSheet(
  _options: ActionSheetIOSOptions,
  _callback: (index: number) => void,
): void {
  throw new Error("The iOS action sheet is only available on iOS");
}
