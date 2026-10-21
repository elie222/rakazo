import { MenuView } from "@expo/ui/community/menu";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { NativeSymbol } from "./native-symbol";
import { Chevron } from "./row-accessories";

export type MenuPickerChoice = { key: string; label: string };

/** Native choice menu shared by rows with different layouts. */
export function MenuPickerMenu({
  label,
  choices,
  value,
  onChange,
  children,
}: {
  label: string;
  choices: readonly MenuPickerChoice[];
  value: string;
  onChange: (key: string) => void;
  children: ReactNode;
}) {
  const colorScheme = useResolvedAppearance();
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
      {children}
    </MenuView>
  );
}

/**
 * A list row that opens a native menu of choices; the current one carries the system checkmark.
 * With `onPress` it pushes a list instead, for choices too many for a menu.
 */
export function MenuPicker({
  label,
  choices,
  value,
  onChange,
  onPress,
  divider = false,
}: {
  label: string;
  choices: readonly MenuPickerChoice[];
  value: string;
  onChange: (key: string) => void;
  onPress?: () => void;
  divider?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const current = choices.find((choice) => choice.key === value)?.label ?? choices[0]?.label ?? "";
  const row = {
    accessibilityLabel: label,
    accessibilityRole: "button",
    accessibilityValue: { text: current },
    accessible: true,
  } as const;
  const content = (
    <>
      <Text style={styles.label}>{label}</Text>
      <Text numberOfLines={1} style={styles.value}>
        {current}
      </Text>
      {onPress ? (
        <Chevron />
      ) : (
        <NativeSymbol
          android="chevron-expand"
          color={native.tertiaryLabel}
          ios="chevron.up.chevron.down"
          size={13}
        />
      )}
    </>
  );
  if (onPress) {
    return (
      <Pressable
        {...row}
        onPress={onPress}
        style={({ pressed }) => [styles.row, divider && styles.divider, pressed && styles.pressed]}
      >
        {content}
      </Pressable>
    );
  }
  const menu = (
    <MenuPickerMenu choices={choices} label={label} onChange={onChange} value={value}>
      <View {...row} style={styles.row}>
        {content}
      </View>
    </MenuPickerMenu>
  );
  // The native menu sizes to its content; keep the divider at the group width.
  return divider ? <View style={styles.divider}>{menu}</View> : menu;
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
    pressed: {
      backgroundColor: native.fillPressed,
    },
  });
}
