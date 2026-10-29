import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import { RoutineRunHistory } from "../components/routine-run-history";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { routineStatusLine } from "../lib/routine";
import { useBotRoutines } from "../lib/routine-store";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function RoutineDetail() {
  const sideInsets = useSideInsets();
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const { botId, botName, routineId, origin } = useLocalSearchParams<{
    botId?: string;
    botName?: string;
    routineId?: string;
    origin?: string;
  }>();
  const router = useRouter();
  // Opened from the list, the routine is already known; it still reads again. A routine missing
  // from what was known before only counts as gone once that read answers.
  const {
    routines,
    error: loadError,
    readSinceShown,
    failedSinceShown,
  } = useBotRoutines(botId ?? "", { poll: false });
  const routine = routines?.find((item) => item.id === routineId) ?? null;
  const error =
    !botId || !routineId
      ? t("Routine link is incomplete")
      : routine
        ? null
        : failedSinceShown
          ? errorText(loadError, t("Could not load routine"))
          : readSinceShown
            ? t("This routine no longer exists")
            : null;
  const loading = !routine && !error;

  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
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
            }}
          >
            <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>
              {routineStatusLine(routine)}
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
          {origin !== "profile" ? (
            <NativeActionButton
              label={t("Open conversation")}
              onPress={() =>
                router.push({
                  pathname: "/thread",
                  params: { botId: botId ?? "", name: botName ?? t("Bot") },
                })
              }
            />
          ) : null}
          <RoutineRunHistory routineId={routine.id} botName={botName} />
        </>
      ) : null}
    </ScrollView>
  );
}
