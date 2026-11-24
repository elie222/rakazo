import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { displayName } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "../components/bots/bot-avatar";
import { useBotEmail, useBotEmailRows } from "../components/bots/bot-email";
import { botProfileMenuOptions, useBotProfileActions } from "../components/bots/bot-profile-menu";
import { glassHeaderOptions } from "../components/native/glass-title";
import { NativeActionButton } from "../components/native/native-action-button";
import { NativeSymbol } from "../components/native/native-symbol";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
  useStackedSettings,
} from "../components/settings/settings-group";
import { errorText } from "../lib/api/user-error";
import { useNotifyOnFinish } from "../lib/bots/bot-setting";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useMobileTokens, useThemedStyles } from "../lib/native/native";
import { rpcQuery } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { useBotRoutines } from "../lib/routines/routine-store";

/** Keyed by the bot, so a switch saving for one bot never takes a tap meant for another. */
export default function BotProfile() {
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  return <BotProfileScreen key={botId} />;
}

function BotProfileScreen() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const stacked = useStackedSettings();
  const { botId = "", name: nameParam } = useLocalSearchParams<{ botId?: string; name?: string }>();
  // Read on focus too, so edits made in Chat settings or a routine show on return.
  const bot = useScreenQuery(rpcQuery("bots/get", { botId }), { enabled: Boolean(botId) }).data;
  const computerRead = useScreenQuery(rpcQuery("computer/status", { botId }), {
    enabled: Boolean(botId),
  });
  // A stale Running or Asleep is worse than no state, so only this visit's answer shows.
  const computer =
    computerRead.isFetchedAfterMount && !computerRead.isError ? computerRead.data : null;
  const name = displayName(bot?.name ?? nameParam, t`Bot`);
  const { routines } = useBotRoutines(botId);
  const actions = useBotProfileActions(botId, name);
  // The chat list's Silence notifications saves the same setting.
  const notify = useNotifyOnFinish(botId, bot?.notifyOnFinish ?? true, (error) =>
    Alert.alert(t`Could not update notifications`, errorText(error, t`Try again.`)),
  );

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
        {bot?.meetingsEnabled ? (
          <SettingsRow
            key="meetings"
            accessibilityRole="button"
            chevron="right"
            title={t`Meetings`}
            leading={
              <NativeSymbol ios="video" android="videocam-outline" color={tokens.mutedForeground} />
            }
            onPress={() => router.push({ pathname: "/meetings", params: { botId } })}
          />
        ) : null}
      </SettingsGroup>
      <BotEmailGroup botId={botId} botName={name} />
      {bot ? (
        <SettingsGroup footer={t`Get notified when this Bot finishes or needs input`}>
          <SettingsSwitch
            key="notifications"
            label={t`Notifications`}
            value={notify.value}
            onChange={notify.set}
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
