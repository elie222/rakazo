import type { ColorValue } from "react-native";
import { Platform } from "react-native";
import { native } from "./native";

/** Subtle bounded ripple used by Android pressables; iOS keeps its opacity feedback. */
export function androidRipple(color: ColorValue = native.fillPressed) {
  return Platform.OS === "android" ? { color } : undefined;
}
