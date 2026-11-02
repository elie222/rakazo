import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { selectNotificationAccount } from "../lib/account-sessions";
import { currentApiBase } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { notificationOpenTargetFromLink } from "../lib/notification-open";

/** Android and external notification links resolve identity before mounting a private screen. */
export default function NotificationOpen() {
  const { target } = useLocalSearchParams<{ target?: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const [result, setResult] = useState<"pending" | "sign-in" | "retry">("pending");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setResult("pending");
    const route = target ? notificationOpenTargetFromLink(target) : null;
    if (!route) {
      setResult("sign-in");
      return;
    }
    void selectNotificationAccount(route.params.userId, route.params.apiBase)
      .then((selected) => {
        if (!active) return;
        if (selected)
          router.replace({
            ...route,
            params: {
              ...route.params,
              ...(route.params.apiBase ? { apiBase: currentApiBase() } : {}),
            },
          });
        else setResult("sign-in");
      })
      .catch(() => {
        if (active) setResult("retry");
      });
    return () => {
      active = false;
    };
  }, [router, target, attempt]);
  return (
    <View style={styles.screen}>
      {result !== "pending" ? (
        <>
          <Text style={styles.message}>
            {result === "retry" ? t("Could not continue") : t("Sign in to open this notification")}
          </Text>
          <NativeActionButton
            label={result === "retry" ? t("Try again") : t("Sign in")}
            onPress={() => {
              if (result === "retry") {
                setResult("pending");
                setAttempt((previous) => previous + 1);
                return;
              }
              router.replace({
                pathname: "/sign-in",
                params: { mode: "in", addAccount: "1", notificationTarget: target },
              });
            }}
          />
          <NativeActionButton
            label={t("Back")}
            prominence="secondary"
            onPress={() => router.replace("/")}
          />
        </>
      ) : (
        <ActivityIndicator accessibilityLabel={t("Loading…")} color={tokens.mutedForeground} />
      )}
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.background,
      gap: 16,
      padding: 24,
    },
    message: { color: tokens.foreground },
  });
}
