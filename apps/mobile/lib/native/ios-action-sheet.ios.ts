import type { ActionSheetIOSOptions } from "react-native";
import { ActionSheetIOS } from "react-native";

export function showIOSActionSheet(
  options: ActionSheetIOSOptions,
  callback: (index: number) => void,
): void {
  ActionSheetIOS.showActionSheetWithOptions(options, callback);
}
