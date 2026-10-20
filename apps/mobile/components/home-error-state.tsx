import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import type { LoadFailureKind } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { NativeSymbol } from "./native-symbol";

const SYMBOLS = {
  offline: { ios: "wifi.slash", android: "cloud-offline-outline" },
  session: { ios: "person.crop.circle.badge.exclamationmark", android: "person-circle-outline" },
  server: { ios: "exclamationmark.icloud", android: "cloud-outline" },
  other: { ios: "exclamationmark.circle", android: "alert-circle-outline" },
} as const;

/** Centered, like the system's content-unavailable view: what went wrong, then what to do. */
export function HomeErrorState({
  kind,
  message,
  loading,
  onRetry,
  onSignIn,
}: {
  kind: LoadFailureKind;
  /** Shown under the title only when the cause is unknown. */
  message: string;
  /** A retry is in flight: the failure stays, with a spinner in place of the action. */
  loading: boolean;
  onRetry: () => void;
  onSignIn: () => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  // Secondary gray reads faint on the dark page; lift the icon a step there.
  const iconColor = useResolvedAppearance() === "dark" ? native.label : native.secondaryLabel;
  const title =
    kind === "offline"
      ? t("Could not reach the server")
      : kind === "session"
        ? t("Your session expired")
        : kind === "server"
          ? t("The server had a problem")
          : t("Could not load chats");
  const detail = kind === "other" && message !== title ? message : null;
  return (
    <View accessibilityRole="alert" style={styles.container}>
      <View style={styles.icon}>
        <NativeSymbol {...SYMBOLS[kind]} size={40} color={iconColor} />
      </View>
      <Text style={styles.title}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      {loading ? (
        <View style={styles.action}>
          <ActivityIndicator color={native.secondaryLabel} />
        </View>
      ) : kind === "session" ? (
        <View style={styles.action}>
          <NativeActionButton label={t("Sign in")} fill={false} onPress={onSignIn} />
        </View>
      ) : kind !== "server" ? (
        // A server fault is not fixed by retrying right away; pull to refresh still reloads.
        <View style={styles.action}>
          <NativeActionButton
            label={t("Try again")}
            prominence="secondary"
            size="compact"
            onPress={onRetry}
          />
        </View>
      ) : null}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 32,
      // Sit above the middle, where the eye expects the center.
      paddingBottom: 210,
      gap: 8,
    },
    title: {
      marginTop: 4,
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
      textAlign: "center",
    },
    detail: {
      color: native.secondaryLabel,
      fontSize: 15,
      lineHeight: 20,
      textAlign: "center",
    },
    icon: { opacity: 0.75 },
    // Fixed height so swapping the button for the spinner does not move the text.
    action: { marginTop: 8, minHeight: 34, justifyContent: "center" },
  });
}
