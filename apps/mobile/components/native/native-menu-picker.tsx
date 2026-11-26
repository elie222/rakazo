import type { MenuPickerChoice } from "../ui/menu-picker";
import { MenuPicker } from "../ui/menu-picker";

export type NativeMenuPickerProps = {
  label: string;
  choices: readonly MenuPickerChoice[];
  value: string;
  onChange: (key: string) => void;
};

/** A compact choice menu showing the current choice. iOS uses a SwiftUI menu picker. */
export function NativeMenuPicker({ label, choices, value, onChange }: NativeMenuPickerProps) {
  return (
    <MenuPicker
      label={label}
      showLabel={false}
      plain
      choices={choices}
      value={value}
      onChange={onChange}
    />
  );
}
