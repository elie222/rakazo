import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { selectNotificationAccount } from "../lib/account-sessions";
import { currentApiBase } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { notificationOpenTargetFromLink } from "../lib/notification-open";
import { promptNotificationSignIn } from "../lib/open-notification";

/** Android and external notification links resolve identity before mounting a private screen. */
export default function NotificationOpen() {
  const { target } = useLocalSearchParams<{ target?: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const route = target ? notificationOpenTargetFromLink(target) : null;
    if (!target || !route) {
      router.replace("/");
      return;
    }
    void selectNotificationAccount(route.params.userId, route.params.apiBase)
      .then((account) => {
        if (!active) return;
        if (account !== "selected") {
          router.replace("/");
          if (account === "signed-out") promptNotificationSignIn(target);
          return;
        }
        router.replace({
          ...route,
          params: {
            ...route.params,
            ...(route.params.apiBase ? { apiBase: currentApiBase() } : {}),
          },
        });
      })
      .catch(() => {
        if (!active) return;
        Alert.alert(t("Could not continue"), undefined, [
          { text: t("Cancel"), style: "cancel", onPress: () => router.replace("/") },
          { text: t("Try again"), onPress: () => setAttempt((previous) => previous + 1) },
        ]);
      });
    return () => {
      active = false;
    };
  }, [router, target, attempt, t]);
  return (
    <View style={styles.screen}>
      <ActivityIndicator accessibilityLabel={t("Loading…")} color={tokens.mutedForeground} />
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
    },
  });
}
