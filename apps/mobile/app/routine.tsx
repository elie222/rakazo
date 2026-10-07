import type { Routine } from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";

export default function RoutineDetail() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const { botId, botName, routineId } = useLocalSearchParams<{
    botId?: string;
    botName?: string;
    routineId?: string;
  }>();
  const router = useRouter();
  const [routine, setRoutine] = useState<Routine | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!botId || !routineId) {
      setError(t("Routine link is incomplete"));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void rpc<Routine[]>("routines/list", { botId })
      .then((routines) => {
        if (cancelled) return;
        const match = routines.find((item) => item.id === routineId);
        if (match) setRoutine(match);
        else setError(t("This routine no longer exists"));
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(errorText(loadError, t("Could not load routine")));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, routineId]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.background }}
      contentContainerStyle={{ padding: 24, gap: 18 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={glassHeaderOptions(routine?.name ?? t("Routine"))} />
      {loading ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
      {error ? <Text style={{ color: tokens.destructive, fontSize: 15 }}>{error}</Text> : null}
      {routine ? (
        <>
          <View
            style={{
              borderRadius: 16,
              backgroundColor: native.fill,
              padding: 18,
              gap: 8,
            }}
          >
            <Text style={{ color: tokens.foreground, fontSize: 20, fontWeight: "600" }}>
              {routine.name}
            </Text>
            <Text
              style={{
                color: routine.active ? tokens.success : tokens.mutedForeground,
                fontSize: 14,
              }}
            >
              {[
                routine.active ? t("Active") : t("Paused"),
                [
                  ...routine.crons,
                  ...(routine.webhookEnabled ? [t("Webhook")] : []),
                  ...(routine.githubEnabled ? [t("Git event")] : []),
                  ...(routine.messageProvider === "slack"
                    ? [t("Slack message")]
                    : routine.messageProvider === "teams"
                      ? [t("Teams message")]
                      : routine.messageProvider
                        ? [t("Message event")]
                        : []),
                ].join(", "),
                routine.timezone,
              ].join(" · ")}
            </Text>
          </View>
          <View style={{ gap: 8 }}>
            <Text
              style={{ color: tokens.mutedForeground, fontSize: 13, textTransform: "uppercase" }}
            >
              {t("Prompt")}
            </Text>
            <Text
              selectable
              style={{
                color: tokens.foreground,
                fontSize: 15,
                lineHeight: 23,
                borderRadius: 16,
                backgroundColor: native.fill,
                padding: 18,
              }}
            >
              {routine.prompt}
            </Text>
          </View>
          <NativeActionButton
            label={t("Open conversation")}
            onPress={() =>
              router.push({
                pathname: "/thread",
                params: { botId: botId ?? "", name: botName ?? t("Bot") },
              })
            }
          />
        </>
      ) : null}
    </ScrollView>
  );
}
