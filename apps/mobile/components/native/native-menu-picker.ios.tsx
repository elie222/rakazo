import { Host, Picker, Text } from "@expo/ui/swift-ui";
import { labelsHidden, pickerStyle, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { useMobileTokens, useResolvedAppearance } from "../../lib/native/native";
import { selectionChangeHandler } from "../../lib/native/native-control-actions";
import type { NativeMenuPickerProps } from "./native-menu-picker";

/** SwiftUI menu picker: the current choice with the system chevrons, opening a native menu. */
export function NativeMenuPicker({ label, choices, value, onChange }: NativeMenuPickerProps) {
  const scheme = useResolvedAppearance();
  const tokens = useMobileTokens();
  const select = selectionChangeHandler(value, false, onChange);
  return (
    <Host colorScheme={scheme} matchContents>
      <Picker
        label={label}
        modifiers={[pickerStyle("menu"), labelsHidden(), tint(tokens.foreground)]}
        onSelectionChange={(selection) => {
          const match = choices.find((choice) => choice.key === selection);
          if (match) select(match.key);
        }}
        selection={value}
      >
        {choices.map((choice) => (
          <Text key={choice.key} modifiers={[tag(choice.key)]}>
            {choice.label}
          </Text>
        ))}
      </Picker>
    </Host>
  );
}
