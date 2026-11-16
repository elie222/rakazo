import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { displayName } from "@rakazo/core";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { useBotEmail, useBotEmailRows } from "../components/bot-email";
import { botProfileMenuOptions, useBotProfileActions } from "../components/bot-profile-menu";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSymbol } from "../components/native-symbol";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
  useStackedSettings,
} from "../components/settings-group";
import { currentApiBase, rpc, selectedSpaceId } from "../lib/api";
import { afterChatNotifyChange } from "../lib/live-notifications";
import type { MobileBot } from "../lib/mobile-types";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";
import { createQueuedSave } from "../lib/queued-save";
import { useBotRoutines } from "../lib/routine-store";
import { loadSessionToken } from "../lib/session";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function BotProfile() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const stacked = useStackedSettings();
  const { botId = "", name: nameParam } = useLocalSearchParams<{ botId?: string; name?: string }>();
  const [bot, setBot] = useState<MobileBot | null>(null);
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const name = displayName(bot?.name ?? nameParam, t`Bot`);
  const { routines } = useBotRoutines(botId);
  const actions = useBotProfileActions(botId, name);
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
      void rpc("computer/status", { botId })
        .then((next) => {
          if (current) setComputer(next);
        })
        // A stale Running or Asleep is worse than no state.
        .catch(() => {
          if (current) setComputer(null);
        });
      return () => {
        current = false;
      };
    }, [botId]),
  );

  // The chat list's Mute saves the same setting. The switch moves first and moves back if the
  // save fails.
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
            { botId, threadId: bot.threadId, notify },
          );
        } catch {
          // The server save succeeded; device reconciliation can retry later.
        }
      },
      onError: (error) =>
        Alert.alert(t`Could not update notifications`, errorText(error, t`Try again.`)),
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
          ...(botId ? botProfileMenuOptions(actions, t`Bot actions`, tokens.foreground) : null),
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
        <NativeActionButton
          label={t`Edit`}
          prominence="secondary"
          style={styles.edit}
          onPress={() => router.push({ pathname: "/bot-settings", params: { botId } })}
        />
      </View>
      <SettingsGroup>
        <SettingsRow
          key="routines"
          accessibilityRole="button"
          chevron="right"
          title={t`Routines`}
          leading={
            <NativeSymbol ios="clock" android="time-outline" color={tokens.mutedForeground} />
          }
          // Counts the routines that are switched on; nothing until the first read lands.
          value={
            routines
              ? t`${ph({ count: routines.filter((routine) => routine.active).length })} on`
              : undefined
          }
          onPress={() => router.push({ pathname: "/routines", params: { botId, name } })}
        />
        <SettingsRow
          key="pages"
          accessibilityRole="button"
          chevron="right"
          title={t`Pages`}
          leading={
            <NativeSymbol
              ios="doc.richtext"
              android="document-text-outline"
              color={tokens.mutedForeground}
            />
          }
          onPress={() => router.push({ pathname: "/pages", params: { botId } })}
        />
        <SettingsRow
          key="artifacts"
          accessibilityRole="button"
          chevron="right"
          title={t`Artifacts`}
          leading={
            <NativeSymbol ios="folder" android="folder-outline" color={tokens.mutedForeground} />
          }
          onPress={() => router.push({ pathname: "/artifacts", params: { botId } })}
        />
        <SettingsRow
          key="computer"
          accessibilityRole="button"
          chevron="right"
          title={t`Computer`}
          leading={
            <NativeSymbol
              ios="desktopcomputer"
              android="desktop-outline"
              color={tokens.mutedForeground}
            />
          }
          value={
            computer?.state === "running"
              ? t`Running`
              : computer?.state === "suspended"
                ? t`Asleep`
                : undefined
          }
          onPress={() => router.push({ pathname: "/computer", params: { botId, name } })}
        />
      </SettingsGroup>
      <BotEmailGroup botId={botId} botName={name} />
      {bot ? (
        <SettingsGroup footer={t`Get notified when this Bot finishes or needs input`}>
          <SettingsSwitch
            key="notifications"
            label={t`Notifications`}
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
    edit: { alignSelf: "center", marginTop: 4 },
    avatarSpace: { width: 96, height: 96 },
    name: { color: native.label, fontSize: 22, fontWeight: "600", textAlign: "center" },
  });
}

/** The bot's address; on a server that receives email, offered until claimed. */
function BotEmailGroup({ botId, botName }: { botId: string; botName: string }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const email = useBotEmail(botId);
  const rows = useBotEmailRows({ botId, botName, email });
  const [claiming, setClaiming] = useState(false);
  if (!email.address) return null;
  return (
    <SettingsGroup label={t`Email`}>
      {email.address.address || claiming
        ? rows
        : [
            <SettingsRow
              key="offer"
              accessibilityRole="button"
              title={t`Get an email address`}
              leading={
                <NativeSymbol
                  ios="envelope"
                  android="mail-outline"
                  color={tokens.mutedForeground}
                />
              }
              onPress={() => setClaiming(true)}
            />,
          ]}
    </SettingsGroup>
  );
}
