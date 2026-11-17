import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type {
  AutomatedSenderPolicies,
  AutomatedSenderPolicyMode,
  RpcInput,
} from "@rakazo/contracts";
import type { ListenMode } from "@rakazo/core";
import {
  AUTOMATED_SENDER_MODES,
  ambientValue,
  listenMode,
  roomAutomatedSenders,
  senderPolicy,
  withRollupHours,
  withSenderMode,
} from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useContext, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { LoadFailure } from "../../components/load-failure";
import { MenuPickerMenu } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { CallKeyboardContext } from "../../lib/call-keyboard-context";
import { native, useMobileTokens, useThemedStyles } from "../../lib/native";
import { formRead, queryClient, rpcQuery, useSave } from "../../lib/query";
import { useScreenHeader } from "../../lib/screen-header";
import { errorText } from "../../lib/user-error";

/** Reply mode, instructions, and automated-sender handling for one team chat room. */
export default function TeamConversationSettings() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  // Keyed by room, so another room never starts from this one's unsaved edits.
  return <RoomSettings key={conversationId} conversationId={conversationId} />;
}

function RoomSettings({ conversationId }: { conversationId: string }) {
  const rootAvoidsKeyboard = useContext(CallKeyboardContext);
  const { t } = useLingui();
  const router = useRouter();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const spacesQuery = useQuery(formRead(rpcQuery("spaces/list")), queryClient);
  const botsQuery = useQuery(formRead(rpcQuery("bots/list")), queryClient);
  const room = spacesQuery.data?.current.externalConversations.find(
    (candidate) => candidate.id === conversationId,
  );
  const roomBot = botsQuery.data?.find((candidate) => candidate.id === room?.botId);
  // A copy read for the room shown before this one is not what Save may start from.
  const fresh = spacesQuery.isFetchedAfterMount && botsQuery.isFetchedAfterMount;
  const loaded = fresh && room && roomBot ? { conversation: room, bot: roomBot } : null;
  const ready = Boolean(loaded);
  const failedRead = [spacesQuery, botsQuery].find((read) => read.isError && !read.isFetching);
  const loadError = failedRead ? errorText(failedRead.error) : null;
  // Each stays unset until edited, so what is shown and saved for the rest is what was read.
  const [modeEdit, setMode] = useState<ListenMode>();
  const [rulesEdit, setRules] = useState<string | null>();
  const [policiesEdit, setPolicies] = useState<AutomatedSenderPolicies>();
  // Typed hours stay a draft until saved, so Save works while the field still has focus.
  const [hoursDrafts, setHoursDrafts] = useState<Record<string, string>>({});
  const change = useSave({
    save: (policy: RpcInput<"externalConversations/updatePolicy">, send) =>
      send("externalConversations/updatePolicy", policy),
    onSaved: () => router.back(),
    closesScreen: true,
    // Save sits in the header, so a failure needs to show where the person is looking.
    onFailed: (err) => Alert.alert(errorText(err, t`Could not save`)),
  });
  const saving = change.pending;
  const saveRef = useRef(() => {});
  const title = loaded ? loaded.conversation.displayName || t`External conversation` : "";

  useScreenHeader({
    title,
    action: ready ? { label: t`Save`, busy: saving, onPress: () => saveRef.current() } : null,
  });

  if (!loaded) {
    return loadError ? (
      <View style={styles.content}>
        <LoadFailure
          message={loadError}
          onRetry={() => {
            for (const read of [spacesQuery, botsQuery]) if (read.isError) void read.refetch();
          }}
        />
      </View>
    ) : null;
  }
  const { conversation, bot } = loaded;
  const mode = modeEdit ?? listenMode(conversation.teamChatAmbientEnabled);
  const rules = rulesEdit === undefined ? conversation.teamChatRules || null : rulesEdit;
  const policies = policiesEdit ?? conversation.automatedSenderPolicies;
  const senders = roomAutomatedSenders(policies, conversation.automatedSenders);
  const listening = ambientValue(mode) ?? bot.teamChatAmbientEnabled;
  const replyLabels: Record<Exclude<ListenMode, "inherit">, string> = {
    listen: t`Every message`,
    mentions: t`Mentions only`,
  };
  const senderModeLabels: Record<AutomatedSenderPolicyMode, string> = {
    ignore: t`Ignore`,
    rollup: t`Group updates`,
    action: t`Always act`,
    user: t`Treat like a person`,
  };

  saveRef.current = () =>
    change.run({
      externalConversationId: conversation.id,
      teamChatAmbientEnabled: ambientValue(mode),
      teamChatRules: rules,
      automatedSenderPolicies: senders.reduce(
        (current, sender) =>
          hoursDrafts[sender.id] !== undefined && current[sender.id]?.mode === "rollup"
            ? withRollupHours(current, sender, Number(hoursDrafts[sender.id]))
            : current,
        policies,
      ),
    });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      automaticallyAdjustKeyboardInsets={!rootAvoidsKeyboard}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <SettingsGroup>
        <MenuPickerMenu
          label={t`Replies to`}
          choices={[
            { key: "inherit", label: t`Same as ${ph({ bot: bot.name })}` },
            { key: "listen", label: replyLabels.listen },
            { key: "mentions", label: replyLabels.mentions },
          ]}
          value={mode}
          onChange={(next) => setMode(next as ListenMode)}
        >
          <View>
            <SettingsRow
              accessibilityLabel={t`Replies to`}
              accessibilityRole="button"
              accessible
              title={t`Replies to`}
              value={replyLabels[listening ? "listen" : "mentions"]}
              trailing={
                <NativeSymbol
                  android="chevron-expand"
                  color={native.tertiaryLabel}
                  ios="chevron.up.chevron.down"
                  size={13}
                />
              }
            />
          </View>
        </MenuPickerMenu>
      </SettingsGroup>
      <View>
        <View style={styles.labelRow}>
          <Text style={styles.label}>{t`Instructions for this room`}</Text>
          {rules !== null ? (
            <NativeActionButton
              label={t`Reset`}
              prominence="quiet"
              variant="text"
              size="compact"
              fill={false}
              onPress={() => setRules(null)}
            />
          ) : null}
        </View>
        <TextInput
          accessibilityLabel={t`Instructions for this room`}
          value={rules ?? ""}
          // An emptied field follows the bot again, as it shows.
          onChangeText={(text) => setRules(text || null)}
          maxLength={4000}
          multiline
          placeholder={bot.teamChatRules || undefined}
          placeholderTextColor={tokens.mutedForeground}
          style={[styles.input, { color: tokens.foreground }]}
        />
      </View>
      {senders.length ? (
        <SettingsGroup label={t`Automated senders`}>
          {senders.flatMap((sender) => {
            const policy = senderPolicy(policies, sender);
            const row = (
              <MenuPickerMenu
                key={sender.id}
                label={sender.name}
                choices={AUTOMATED_SENDER_MODES.map((value) => ({
                  key: value,
                  label: senderModeLabels[value],
                }))}
                value={policy.mode}
                onChange={(next) =>
                  setPolicies((current) =>
                    withSenderMode(current ?? policies, sender, next as AutomatedSenderPolicyMode),
                  )
                }
              >
                <View>
                  <SettingsRow
                    accessibilityLabel={sender.name}
                    accessibilityRole="button"
                    accessible
                    title={sender.name}
                    value={senderModeLabels[policy.mode]}
                    trailing={
                      <NativeSymbol
                        android="chevron-expand"
                        color={native.tertiaryLabel}
                        ios="chevron.up.chevron.down"
                        size={13}
                      />
                    }
                  />
                </View>
              </MenuPickerMenu>
            );
            if (policy.mode !== "rollup") return [row];
            return [
              row,
              <SettingsRow
                key={`${sender.id}:rollup`}
                title={t`Every`}
                trailing={
                  <View style={styles.hours}>
                    <TextInput
                      accessibilityLabel={t`${ph({ sender: sender.name })} rollup hours`}
                      keyboardType="number-pad"
                      value={hoursDrafts[sender.id] ?? String(policy.rollupHours ?? 6)}
                      onChangeText={(text) =>
                        setHoursDrafts((current) => ({ ...current, [sender.id]: text }))
                      }
                      style={[styles.hoursInput, { color: tokens.foreground }]}
                    />
                    <Text style={styles.hint}>{t`hours`}</Text>
                  </View>
                }
              />,
            ];
          })}
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    content: { padding: 16, gap: 20 },
    labelRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      minHeight: 32,
      paddingHorizontal: 4,
    },
    label: { color: native.secondaryLabel, fontSize: 13 },
    hint: { color: native.tertiaryLabel, fontSize: 13 },
    input: {
      marginTop: 8,
      backgroundColor: native.fill,
      borderRadius: 11,
      padding: 14,
      fontSize: 16,
      minHeight: 140,
      textAlignVertical: "top",
    },
    hours: { flexDirection: "row", alignItems: "center", gap: 6 },
    hoursInput: {
      minWidth: 48,
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: 8,
      backgroundColor: native.fill,
      textAlign: "right",
      fontSize: 16,
    },
  });
}
