import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { typeScale } from "@rakazo/ui-tokens";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { hangUp, useCallSession } from "../../lib/calls/call-session";
import { callClock, restoreCall, useCallElapsed } from "../../lib/calls/call-view";
import { useMobileTokens } from "../../lib/native/native";
import { NativeSymbol } from "../native/native-symbol";

/**
 * Brings a minimized call back to full screen. Above the composer it is a green bar; in the iOS 26
 * tab bar's accessory, which is glass already, it is a row with the call's clock and End, and
 * beside a minimized tab bar ("inline") just the phone and the clock.
 */
export function CallReturnBar({ inTabBar }: { inTabBar?: "regular" | "inline" }) {
  const call = useCallSession();
  const elapsed = useCallElapsed();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  if (!call) return null;
  const label = t`Return to call with ${ph({ name: call.botName })}`;
  if (inTabBar) {
    return (
      <View style={styles.tabRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={restoreCall}
          style={({ pressed }) => [styles.tabMain, pressed && styles.pressed]}
        >
          <NativeSymbol ios="phone.fill" android="call" size={15} color={tokens.success} />
          {inTabBar === "regular" ? (
            <Text numberOfLines={1} style={[styles.tabName, { color: tokens.foreground }]}>
              {call.botName}
            </Text>
          ) : null}
          <Text style={[styles.tabClock, { color: tokens.success }]}>{callClock(elapsed)}</Text>
        </Pressable>
        {inTabBar === "regular" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t`Hang up`}
            hitSlop={5}
            onPress={hangUp}
            style={({ pressed }) => [
              styles.end,
              { backgroundColor: tokens.destructiveFill },
              pressed && styles.pressed,
            ]}
          >
            <NativeSymbol
              ios="phone.down.fill"
              android={{ material: "phone-hangup" }}
              size={14}
              color={tokens.destructiveForeground}
            />
          </Pressable>
        ) : null}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={restoreCall}
      style={({ pressed }) => [
        styles.bar,
        { backgroundColor: tokens.success, marginBottom: insets.bottom + 8 },
        pressed && styles.pressed,
      ]}
    >
      <Text numberOfLines={1} style={[styles.barText, { color: tokens.background }]}>
        {label}
      </Text>
      <Text style={[styles.barText, styles.clock, { color: tokens.background }]}>
        {callClock(elapsed)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 44,
    marginTop: 8,
    marginHorizontal: 16,
    paddingHorizontal: 16,
    borderRadius: 22,
  },
  barText: { ...typeScale.secondary, fontWeight: "600", flexShrink: 1 },
  clock: { fontVariant: ["tabular-nums"] },
  tabRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 },
  tabMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  tabName: { ...typeScale.secondary, fontWeight: "600", flexShrink: 1 },
  tabClock: { ...typeScale.secondary, fontWeight: "600", fontVariant: ["tabular-nums"] },
  end: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.7 },
});
