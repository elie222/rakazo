import { MenuView } from "@expo/ui/community/menu";
import { StyleSheet, Text, View } from "react-native";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

export type MenuPickerChoice = { key: string; label: string };

/** A list row that opens a native menu of choices; the current one carries the system checkmark. */
export function MenuPicker({
  label,
  choices,
  value,
  onChange,
  divider = false,
}: {
  label: string;
  choices: readonly MenuPickerChoice[];
  value: string;
  onChange: (key: string) => void;
  divider?: boolean;
}) {
  const colorScheme = useResolvedAppearance();
  const styles = useThemedStyles(createStyles);
  const current = choices.find((choice) => choice.key === value)?.label ?? choices[0]?.label ?? "";
  return (
    <MenuView
      actions={choices.map((choice) => ({
        // MenuView reports an empty id as the title, so prefix keys to keep "" distinct.
        id: `choice:${choice.key}`,
        title: choice.label,
        state: choice.key === value ? "on" : "off",
      }))}
      colorScheme={colorScheme}
      onPressAction={(event) => {
        const id = event.nativeEvent.event;
        if (id.startsWith("choice:")) onChange(id.slice("choice:".length));
      }}
      title={label}
    >
      <View
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityValue={{ text: current }}
        accessible
        style={[styles.row, divider && styles.divider]}
      >
        <Text style={styles.label}>{label}</Text>
        <Text numberOfLines={1} style={styles.value}>
          {current}
        </Text>
        <NativeSymbol
          android="chevron-expand"
          color={native.tertiaryLabel}
          ios="chevron.up.chevron.down"
          size={13}
        />
      </View>
    </MenuView>
  );
}

function createStyles() {
  return StyleSheet.create({
    row: {
      minHeight: 52,
      paddingHorizontal: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    divider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.separator,
    },
    label: {
      color: native.label,
      fontSize: 16,
    },
    value: {
      flex: 1,
      color: native.secondaryLabel,
      textAlign: "right",
      fontSize: 16,
    },
  });
}
