import type { ColorValue } from "react-native";
import { Platform } from "react-native";
import { native } from "./native";

/** Apply a state-layer alpha to supported literal colors; preserve native colors. */
export function withAlpha(color: ColorValue, alpha: number): ColorValue {
  if (typeof color !== "string") return color;
  const hex = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(color);
  const digits = hex?.[1];
  if (digits) {
    const value = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits;
    const channels = [0, 2, 4].map((offset) =>
      Number.parseInt(value.slice(offset, offset + 2), 16),
    );
    return `rgba(${channels.join(", ")}, ${alpha})`;
  }
  const rgb =
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(?:\d*\.)?\d+)?\s*\)$/i.exec(
      color,
    );
  return rgb ? `rgba(${rgb.slice(1, 4).join(", ")}, ${alpha})` : color;
}

/** A view's own rounded clip only applies to foreground ripples on Android. */
export function androidRipple(color: ColorValue = withAlpha(native.label, 0.12)) {
  return Platform.OS === "android" ? { color, foreground: true } : undefined;
}
