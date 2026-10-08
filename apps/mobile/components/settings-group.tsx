import type { ReactNode } from "react";
import { Children, Fragment, isValidElement } from "react";
import type { PressableProps } from "react-native";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { native, useThemedStyles } from "../lib/native";
import { stacksAtTextScale } from "../lib/text-scale";
import { NativeSwitch } from "./native-switch";
import { Chevron } from "./row-accessories";

export function useStackedSettings(): boolean {
  return stacksAtTextScale(useWindowDimensions().fontScale);
}

export function SettingsLabel({ children }: { children: string }) {
  const styles = useThemedStyles(createSettingsStyles);
  const stacked = useStackedSettings();
  return (
    <Text accessibilityRole="header" style={[styles.groupLabel, stacked && styles.compactLabel]}>
      {children}
    </Text>
  );
}

export function SettingsGroup({
  label,
  accessibilityLabel,
  children,
}: {
  label?: string;
  accessibilityLabel?: string;
  children: ReactNode;
}) {
  const styles = useThemedStyles(createSettingsStyles);
  const stacked = useStackedSettings();
  const rows = Children.toArray(children).filter(isValidElement);
  if (rows.length === 0) return null;
  return (
    <View accessibilityLabel={accessibilityLabel} style={styles.group}>
      {label ? <SettingsLabel>{label}</SettingsLabel> : null}
      <View style={styles.card}>
        {rows.map((row, index) => (
          <Fragment key={row.key}>
            {index > 0 ? (
              <View style={[styles.separator, stacked && styles.compactSeparator]} />
            ) : null}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

type SettingsRowProps = Omit<PressableProps, "children" | "style"> & {
  title: string;
  detail?: string;
  value?: string;
  chevron?: "right" | "down";
  prominent?: boolean;
  destructive?: boolean;
  dimmed?: boolean;
  trailing?: ReactNode;
};

export function SettingsRow({
  title,
  detail,
  value,
  chevron,
  prominent,
  destructive,
  dimmed,
  trailing,
  ...props
}: SettingsRowProps) {
  const styles = useThemedStyles(createSettingsStyles);
  const stacked = useStackedSettings();
  const end = (
    <>
      {value ? <Text style={styles.value}>{value}</Text> : null}
      {trailing}
    </>
  );
  const content = (
    <>
      <View style={styles.titleColumn}>
        <Text
          style={[styles.title, prominent && styles.prominent, destructive && styles.destructive]}
        >
          {title}
        </Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        {stacked ? end : null}
      </View>
      {stacked ? null : end}
      {chevron ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Chevron expanded={chevron === "down"} />
        </View>
      ) : null}
    </>
  );
  if (!props.onPress) {
    return (
      <View
        accessible={props.accessible}
        style={[styles.row, stacked && styles.compactRow, dimmed && styles.dimmed]}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      {...props}
      style={({ pressed }) => [
        styles.row,
        stacked && styles.compactRow,
        pressed && styles.pressed,
        dimmed && styles.dimmed,
      ]}
    >
      {content}
    </Pressable>
  );
}

export function SettingsSwitch({
  label,
  detail,
  value,
  disabled,
  onChange,
}: {
  label: string;
  detail?: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const styles = useThemedStyles(createSettingsStyles);
  const stacked = useStackedSettings();
  const toggle = (
    <View style={stacked ? styles.stackedSwitch : undefined}>
      <NativeSwitch
        accessibilityHint={detail}
        accessibilityLabel={label}
        disabled={disabled}
        onValueChange={onChange}
        value={value}
      />
    </View>
  );
  return (
    <View style={[styles.row, stacked && styles.compactRow]}>
      <View style={styles.titleColumn}>
        <Text style={styles.title}>{label}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        {stacked ? toggle : null}
      </View>
      {stacked ? null : toggle}
    </View>
  );
}

function createSettingsStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    group: { gap: 7 },
    groupLabel: {
      color: native.secondaryLabel,
      fontSize: 13,
      paddingStart: 16,
    },
    card: {
      borderRadius: 16,
      borderCurve: "continuous",
      overflow: "hidden",
      backgroundColor: native.groupedCell,
    },
    separator: {
      height: StyleSheet.hairlineWidth,
      marginStart: 16,
      backgroundColor: native.separator,
    },
    row: {
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    compactLabel: { paddingStart: 12 },
    compactSeparator: { marginStart: 12 },
    compactRow: { paddingHorizontal: 12, gap: 8 },
    titleColumn: { flex: 1, flexShrink: 1, gap: 2 },
    stackedSwitch: { alignSelf: "flex-start", marginTop: 6 },
    title: { color: native.label, fontSize: 17 },
    prominent: { fontSize: 20, fontWeight: "600" },
    detail: { color: native.secondaryLabel, fontSize: 15 },
    destructive: { color: tokens.destructive },
    value: { flexShrink: 1, color: native.secondaryLabel, fontSize: 17 },
    pressed: { backgroundColor: native.fillPressed },
    dimmed: { opacity: 0.45 },
  });
}
