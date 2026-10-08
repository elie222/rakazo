import { Host, Picker, Text } from "@expo/ui/swift-ui";
import { disabled as disable, labelsHidden, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { useResolvedAppearance } from "../lib/native";
import type { NativeSegmentedControlProps } from "../lib/native-controls";
import { SegmentedPills } from "./segmented-pills";

/** SwiftUI segmented picker. An unmatched value keeps the pill fallback. */
export function NativeSegmentedControl<T extends string>({
  accessibilityLabel,
  value,
  onChange,
  options,
  disabled = false,
}: NativeSegmentedControlProps<T>) {
  const scheme = useResolvedAppearance();
  const selected = options.some((option) => option.value === value) ? value : undefined;
  if (selected === undefined) {
    return (
      <SegmentedPills
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        onChange={onChange}
        options={options}
        value={value}
      />
    );
  }
  return (
    <Host
      colorScheme={scheme}
      matchContents={{ vertical: true }}
      style={{ alignSelf: "stretch", minHeight: 32 }}
    >
      <Picker
        label={accessibilityLabel}
        modifiers={[pickerStyle("segmented"), labelsHidden(), ...(disabled ? [disable(true)] : [])]}
        onSelectionChange={(selection) => {
          const match = options.find((option) => option.value === selection);
          if (match) onChange(match.value);
        }}
        selection={selected}
      >
        {options.map((option) => (
          <Text key={option.value} modifiers={[tag(option.value)]}>
            {option.label}
          </Text>
        ))}
      </Picker>
    </Host>
  );
}
