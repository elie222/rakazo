import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import { createElement } from "react";
import type * as ReactNative from "react-native";
import type { TextInputProps, TextProps } from "react-native";

/** From the largest standard text size up, side-by-side settings content stacks vertically. */
export function stacksAtTextScale(fontScale: number): boolean {
  return fontScale >= 1.35;
}

// Marks the capped Text. It lives on the react-native module, which outlasts a Fast Refresh of
// this file, and the global symbol registry gives the reloaded file the same key.
const CAPPED = Symbol.for("rakazo.cappedText");

/**
 * Caps every Text and TextInput at `MAX_FONT_SCALE` unless it sets its own limit. React Native
 * has no app-wide limit and React ignores defaultProps on function components, so this replaces
 * the module's `Text` and `TextInput` (configurable getters) with capped versions. Expo compiles
 * `import { Text } from "react-native"` to a read of the module at render time, so every import
 * in the app gets them.
 */
export function capTextScaling(reactNative: typeof ReactNative = require("react-native")) {
  const { Text, TextInput } = reactNative;
  if (CAPPED in Text) return;
  const CappedText = Object.assign(
    (props: TextProps) =>
      createElement(Text, {
        ...props,
        maxFontSizeMultiplier: props.maxFontSizeMultiplier ?? MAX_FONT_SCALE,
      }),
    { [CAPPED]: true },
  );
  const CappedTextInput = Object.assign(
    (props: TextInputProps) =>
      createElement(TextInput, {
        ...props,
        maxFontSizeMultiplier: props.maxFontSizeMultiplier ?? MAX_FONT_SCALE,
      }),
    TextInput,
  );
  Object.defineProperty(reactNative, "Text", { value: CappedText, enumerable: true });
  Object.defineProperty(reactNative, "TextInput", { value: CappedTextInput, enumerable: true });
}
