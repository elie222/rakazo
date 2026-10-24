import { MenuView } from "@expo/ui/community/menu";
import type { ReactElement } from "react";
import { cloneElement, useState } from "react";
import type { ViewProps } from "react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { native, useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { NativeSymbol } from "./native-symbol";
import { Chevron } from "./row-accessories";

export type MenuPickerChoice = { key: string; label: string };

/** Native choice menu shared by rows with different layouts. */
export function MenuPickerMenu({
  label,
  choices,
  value,
  onChange,
  disabled = false,
  children,
}: {
  label: string;
  choices: readonly MenuPickerChoice[];
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  children: ReactElement<ViewProps>;
}) {
  const colorScheme = useResolvedAppearance();
  // Native menu hosts size to their contents, so measure outside the host.
  const [width, setWidth] = useState<number>();
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={menuStyles.fullWidth}
      pointerEvents={disabled ? "none" : "auto"}
      accessibilityState={{ disabled }}
    >
      <MenuView
        style={menuStyles.fullWidth}
        actions={choices.map((choice) => ({
          // MenuView reports an empty id as the title, so prefix keys to keep "" distinct.
          id: `choice:${choice.key}`,
          title: choice.label,
          state: choice.key === value ? "on" : "off",
          attributes: { disabled },
        }))}
        colorScheme={colorScheme}
        onPressAction={(event) => {
          const id = event.nativeEvent.event;
          if (!disabled && id.startsWith("choice:")) onChange(id.slice("choice:".length));
        }}
        title={label}
      >
        {cloneElement(children, { style: [children.props.style, menuStyles.fullWidth, { width }] })}
      </MenuView>
    </View>
  );
}

const menuStyles = StyleSheet.create({
  fullWidth: { alignSelf: "stretch" },
});

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
  plain = false,
  showLabel = true,
}: {
  label: string;
  choices: readonly MenuPickerChoice[];
  value: string;
  onChange: (key: string) => void;
  onPress?: () => void;
  divider?: boolean;
  plain?: boolean;
  showLabel?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const rowStyle = [styles.row, plain && { paddingHorizontal: 0, minHeight: 44 }];
  const current = choices.find((choice) => choice.key === value)?.label ?? choices[0]?.label ?? "";
  const row = {
    accessibilityLabel: label,
    accessibilityRole: "button",
    accessibilityValue: { text: current },
    accessible: true,
  } as const;
  const content = (
    <>
      {showLabel ? (
        <Text style={[styles.label, plain && { color: tokens.foreground, fontSize: 14 }]}>
          {label}
        </Text>
      ) : null}
      <Text
        numberOfLines={1}
        style={[
          styles.value,
          plain && { color: tokens.foreground, fontSize: 14 },
          !showLabel && { textAlign: "left" },
        ]}
      >
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
        style={({ pressed }) => [rowStyle, divider && styles.divider, pressed && styles.pressed]}
      >
        {content}
      </Pressable>
    );
  }
  const menu = (
    <MenuPickerMenu choices={choices} label={label} onChange={onChange} value={value}>
      <View {...row} style={rowStyle}>
        {content}
      </View>
    </MenuPickerMenu>
  );
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
