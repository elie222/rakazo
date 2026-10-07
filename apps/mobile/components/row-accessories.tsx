import { native } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

/** Trailing disclosure chevron for list rows; points down while a section is expanded. */
export function Chevron({ expanded }: { expanded?: boolean }) {
  return (
    <NativeSymbol
      android={expanded ? "chevron-down" : "chevron-forward"}
      color={native.tertiaryLabel}
      ios={expanded ? "chevron.down" : "chevron.right"}
      size={14}
    />
  );
}

/** Trailing mark on the selected row of a list. */
export function Checkmark() {
  return <NativeSymbol android="checkmark" color={native.label} ios="checkmark" size={16} />;
}
