import { displayName } from "@rakazo/core";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { glassHeaderOptions } from "../components/glass-title";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
  useStackedSettings,
} from "../components/settings-group";
import type { MobileBot } from "../lib/api";
import { currentApiBase, loadSessionToken, rpc, selectedSpaceId } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { afterChatNotifyChange } from "../lib/live-notifications";
import { native, useThemedStyles } from "../lib/native";
import { createQueuedSave } from "../lib/queued-save";
import { useBotRoutines } from "../lib/routine-store";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function BotProfile() {
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const stacked = useStackedSettings();
  const { botId = "", name: nameParam } = useLocalSearchParams<{ botId?: string; name?: string }>();
  const [bot, setBot] = useState<MobileBot | null>(null);
  const name = displayName(bot?.name ?? nameParam, t("Bot"));
  const { routines } = useBotRoutines(botId);
  // Counts switch saves as they start and end, so a reload can tell it overlapped one.
  const notifySaves = useRef(0);
  const notifyQueue = useRef<ReturnType<typeof createQueuedSave<boolean>> | null>(null);

  // Reload on focus so edits made in Chat settings or a routine show on return.
  useFocusEffect(
    useCallback(() => {
      if (!botId) return;
      let current = true;
      const saves = notifySaves.current;
      void rpc("bots/get", { botId })
        .then((next) => {
          if (!current) return;
          // A read that overlapped a save may predate it; keep the switch as the user left it.
          const overlapped = saves % 2 === 1 || saves !== notifySaves.current;
          if (!overlapped) notifyQueue.current?.reset(next.notifyOnFinish);
          setBot((shown) =>
            overlapped && shown ? { ...next, notifyOnFinish: shown.notifyOnFinish } : next,
          );
        })
        .catch(() => undefined);
      return () => {
        current = false;
      };
    }, [botId]),
  );

  // The chat list's Silence notifications saves the same setting. The switch moves
  // first and moves back if the save fails.
  const setNotifyOnFinish = (notifyOnFinish: boolean) => {
    if (!bot) return;
    notifyQueue.current ??= createQueuedSave(bot.notifyOnFinish, {
      onChange: (notifyOnFinish) => setBot((current) => current && { ...current, notifyOnFinish }),
      save: async (notifyOnFinish) => {
        await rpc("bots/update", { botId, notifyOnFinish });
      },
      onSavingChange: () => {
        notifySaves.current += 1;
      },
      onSaved: async (notify) => {
        try {
          await afterChatNotifyChange(
            currentApiBase(),
            await loadSessionToken(),
            selectedSpaceId() ?? "",
            { threadId: bot.threadId, notify },
          );
        } catch {
          // The server save succeeded; device reconciliation can retry later.
        }
      },
      onError: (error) =>
        Alert.alert(t("Could not update notifications"), errorText(error, t("Try again."))),
    });
    notifyQueue.current.update(notifyOnFinish);
  };

  return (
    <ScrollView
      style={[styles.screen, sideInsets]}
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
          <BotAvatar
            color={bot.color}
            avatarSet={bot.avatarSet}
            identity={bot.id}
            size={96}
            status={bot.status}
          />
        ) : (
          <View style={styles.avatarSpace} />
        )}
        <Text accessibilityRole="header" style={styles.name}>
          {name}
        </Text>
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
          key="routines"
          accessibilityRole="button"
          chevron="right"
          title={t("Routines")}
          // Counts the routines that are switched on; nothing until the first read lands.
          value={
            routines
              ? t("{count} on", { count: routines.filter((routine) => routine.active).length })
              : undefined
          }
          onPress={() => router.push({ pathname: "/routines", params: { botId, name } })}
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
      {bot ? (
        <SettingsGroup footer={t("Get notified when this Bot finishes or needs input")}>
          <SettingsSwitch
            key="notifications"
            label={t("Notifications")}
            value={bot.notifyOnFinish}
            onChange={setNotifyOnFinish}
          />
        </SettingsGroup>
      ) : null}
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
  });
}
