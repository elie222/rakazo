import { createElement } from "react";

/** A plain button named by its label, for tests that mock the native glass button. */
export function GlassIconButton({
  accessibilityLabel,
  onPress,
  disabled,
}: {
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return createElement(
    "button",
    { type: "button", onClick: onPress, disabled },
    accessibilityLabel,
  );
}
