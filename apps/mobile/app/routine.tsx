import { Stack, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import { RoutineHealth } from "../components/routine-health";
import { RoutineRunHistory } from "../components/routine-run-history";
import { selectedSpaceId, selectSpace } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import {
  threadRouteSpaceOnFocus,
  threadSpaceRequest,
  threadSpaceSwitchResult,
} from "../lib/notification-open";
import { routineStatusLine } from "../lib/routine";
import { useBotRoutines } from "../lib/routine-store";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function RoutineDetail() {
  const { t } = useI18n();
  const router = useRouter();
  const focused = useIsFocused();
  const { spaceId } = useLocalSearchParams<{ spaceId?: string | string[] }>();
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(() => selectedSpaceId());
  const [switchFailed, setSwitchFailed] = useState(false);
  const [appliedFocus, setAppliedFocus] = useState(focused);
  const sync = threadRouteSpaceOnFocus({
    focused,
    appliedFocus,
    activeSpaceId,
    liveSpaceId: selectedSpaceId(),
    switchFailed,
  });
  if (sync.appliedFocus !== appliedFocus) setAppliedFocus(sync.appliedFocus);
  if (sync.activeSpaceId !== activeSpaceId) setActiveSpaceId(sync.activeSpaceId);
  if (sync.switchFailed !== switchFailed) setSwitchFailed(sync.switchFailed);
  const request = threadSpaceRequest(spaceId, sync.activeSpaceId);
  useEffect(() => {
    if (!focused) return;
    const next = threadSpaceRequest(spaceId, activeSpaceId);
    if (next.action === "show") {
      setSwitchFailed(false);
      return;
    }
    if (next.action === "unavailable") {
      setSwitchFailed(true);
      return;
    }
    let cancelled = false;
    setSwitchFailed(false);
    void selectSpace(next.spaceId).then((switched) => {
      if (cancelled) return;
      if (threadSpaceSwitchResult(next.spaceId, switched, selectedSpaceId()) === "ready")
        setActiveSpaceId(next.spaceId);
      else setSwitchFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSpaceId, focused, spaceId]);
  if (sync.switchFailed || request.action === "unavailable")
    return (
      <View>
        <Text>{t("Could not switch spaces")}</Text>
        <NativeActionButton label={t("Return to inbox")} onPress={() => router.replace("/")} />
      </View>
    );
  if (request.action !== "show") return <ActivityIndicator />;
  return <RoutineDetailContent />;
}

function RoutineDetailContent() {
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
          <RoutineHealth routineId={routine.id} />
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
