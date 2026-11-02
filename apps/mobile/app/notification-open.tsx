import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { selectNotificationAccount } from "../lib/account-sessions";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { notificationOpenTargetFromLink } from "../lib/notification-open";

/** Android and external notification links resolve identity before mounting a private screen. */
export default function NotificationOpen() {
  const { target } = useLocalSearchParams<{ target?: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const route = target ? notificationOpenTargetFromLink(target) : null;
    if (!route) {
      setFailed(true);
      return;
    }
    void selectNotificationAccount(route.params.userId, route.params.apiBase)
      .then((selected) => {
        if (!active) return;
        if (selected) router.replace(route);
        else setFailed(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [router, target]);
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.background,
        gap: 16,
        padding: 24,
      }}
    >
      {failed ? (
        <>
          <Text style={{ color: tokens.foreground }}>{t("Sign in to open this notification")}</Text>
          <NativeActionButton
            label={t("Sign in")}
            onPress={() =>
              router.replace({
                pathname: "/sign-in",
                params: { mode: "in", addAccount: "1", notificationTarget: target },
              })
            }
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
