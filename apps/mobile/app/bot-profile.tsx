import type { Routine } from "@rakazo/contracts";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { glassHeaderOptions } from "../components/glass-title";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../components/settings-group";
import type { MobileBot } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { deviceTimeZone, routineRowDetail, sortRoutinesByNextRun } from "../lib/routine";
import { errorText } from "../lib/user-error";

export default function BotProfile() {
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const stacked = useStackedSettings();
  const { botId = "", name: nameParam } = useLocalSearchParams<{ botId?: string; name?: string }>();
  const [bot, setBot] = useState<MobileBot | null>(null);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [routinesError, setRoutinesError] = useState<string | null>(null);
  const name = bot?.name || nameParam || t("Bot");
  const timeZone = deviceTimeZone();

  // Reload on focus so edits made in Chat settings or a routine show on return.
  useFocusEffect(
    useCallback(() => {
      if (!botId) return;
      let current = true;
      void rpc<MobileBot>("bots/get", { botId })
        .then((next) => {
          if (current) setBot(next);
        })
        .catch(() => undefined);
      return () => {
        current = false;
      };
    }, [botId]),
  );

  // Only the latest load (on focus or retry) may set state; leaving the screen drops them all.
  const routinesRequest = useRef(0);
  const loadRoutines = useCallback(() => {
    if (!botId) return;
    const request = ++routinesRequest.current;
    void rpc<Routine[]>("routines/list", { botId })
      .then((next) => {
        if (request !== routinesRequest.current) return;
        setRoutines(sortRoutinesByNextRun(next));
        setRoutinesError(null);
      })
      .catch((error) => {
        if (request === routinesRequest.current) {
          setRoutinesError(errorText(error, t("Could not load routines")));
        }
      });
    return () => {
      routinesRequest.current += 1;
    };
  }, [botId, t]);
  useFocusEffect(loadRoutines);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, stacked && styles.compactContent]}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen
        options={{
          ...glassHeaderOptions(name),
          // The avatar and name below name the page; the bar title stays for the back menu.
          ...(Platform.OS === "ios" ? { headerTitle: "" } : null),
        }}
      />
      <View style={styles.identity}>
        {bot ? (
          <BotAvatar color={bot.color} identity={bot.id} size={96} status={bot.status} />
        ) : (
          <View style={styles.avatarSpace} />
        )}
        <Text accessibilityRole="header" style={styles.name}>
          {name}
        </Text>
        {bot?.title ? <Text style={styles.title}>{bot.title}</Text> : null}
      </View>
      <SettingsGroup>
        <SettingsRow
          key="settings"
          accessibilityRole="button"
          chevron="right"
          title={t("Chat settings")}
          onPress={() => router.push({ pathname: "/bot-settings", params: { botId } })}
        />
        <SettingsRow
          key="artifacts"
          accessibilityRole="button"
          chevron="right"
          title={t("Artifacts")}
          onPress={() => router.push({ pathname: "/artifacts", params: { botId } })}
        />
        <SettingsRow
          key="computer"
          accessibilityRole="button"
          chevron="right"
          title={t("Computer")}
          onPress={() => router.push({ pathname: "/computer", params: { botId, name } })}
        />
      </SettingsGroup>
      {/* Routines show only once there is something to list, or a load to retry. */}
      <SettingsGroup label={t("Routines")}>
        {routinesError ? (
          <SettingsRow
            key="error"
            accessibilityRole="button"
            title={routinesError}
            detail={t("Try again.")}
            onPress={() => void loadRoutines()}
          />
        ) : (
          routines?.map((routine) => (
            <SettingsRow
              key={routine.id}
              accessibilityRole="button"
              chevron="right"
              title={routine.name}
              detail={routineRowDetail(routine, timeZone)}
              onPress={() =>
                router.push({
                  pathname: "/routine",
                  params: { botId, botName: name, routineId: routine.id, origin: "profile" },
                })
              }
            />
          ))
        )}
      </SettingsGroup>
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 28 },
    compactContent: { paddingHorizontal: 8 },
    identity: { alignItems: "center", gap: 8 },
    avatarSpace: { width: 96, height: 96 },
    name: { color: native.label, fontSize: 22, fontWeight: "600", textAlign: "center" },
    title: { color: native.secondaryLabel, fontSize: 15, textAlign: "center" },
  });
}
