import { typeScale } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { Children, Fragment, isValidElement } from "react";
import type { PressableProps } from "react-native";
import { Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { native, useThemedStyles } from "../lib/native";
import { androidRipple } from "../lib/ripple";
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

export function SettingsFooter({ children }: { children: string }) {
  const styles = useThemedStyles(createSettingsStyles);
  const stacked = useStackedSettings();
  return <Text style={[styles.footer, stacked && styles.compactLabel]}>{children}</Text>;
}

export function SettingsGroup({
  label,
  accessibilityLabel,
  footer,
  children,
}: {
  label?: string;
  accessibilityLabel?: string;
  footer?: string;
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
      {footer ? <SettingsFooter>{footer}</SettingsFooter> : null}
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
  leading?: ReactNode;
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
  leading,
  trailing,
  ...props
}: SettingsRowProps) {
  const styles = useThemedStyles(createSettingsStyles);
  const stacked = useStackedSettings();
  const end = (
    <>
      {value ? (
        <Text
          numberOfLines={stacked ? undefined : 1}
          style={[styles.value, !stacked && styles.inlineValue]}
        >
          {value}
        </Text>
      ) : null}
      {trailing}
    </>
  );
  const content = (
    <>
      {leading}
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
        accessibilityActions={props.accessibilityActions}
        accessibilityHint={props.accessibilityHint}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole={props.accessibilityRole}
        accessibilityState={props.accessibilityState}
        accessibilityValue={props.accessibilityValue}
        onAccessibilityAction={props.onAccessibilityAction}
        style={[styles.row, stacked && styles.compactRow, dimmed && styles.dimmed]}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      {...props}
      android_ripple={androidRipple()}
      style={({ pressed }) => [
        styles.row,
        stacked && styles.compactRow,
        pressed && Platform.OS !== "android" && styles.pressed,
        dimmed && styles.dimmed,
      ]}
    >
      {content}
    </Pressable>
  );
}

export function SettingsSwitch({
  label,
  accessibilityLabel,
  detail,
  value,
  disabled,
  onChange,
}: {
  label: string;
  accessibilityLabel?: string;
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
        accessibilityLabel={accessibilityLabel ?? label}
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
      ...typeScale.caption,
      paddingStart: 16,
    },
    footer: {
      color: native.secondaryLabel,
      ...typeScale.caption,
      paddingHorizontal: 16,
    },
    card: {
      borderRadius: 16,
      borderCurve: "continuous",
      overflow: "hidden",
      backgroundColor: native.groupedCell,
    },
    separator: {
      // iOS draws sheets scaled down slightly, which makes a one-pixel line fall between
      // pixels and vanish at some offsets. Two pixels always leave at least one visible.
      height: StyleSheet.hairlineWidth * 2,
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
    detail: { color: native.secondaryLabel, ...typeScale.caption },
    destructive: { color: tokens.destructive },
    value: { flexShrink: 1, color: native.secondaryLabel, fontSize: 17 },
    // A long value truncates instead of pushing the title out of the row.
    inlineValue: { maxWidth: "60%" },
    pressed: { backgroundColor: native.fillPressed },
    dimmed: { opacity: 0.45 },
  });
}
