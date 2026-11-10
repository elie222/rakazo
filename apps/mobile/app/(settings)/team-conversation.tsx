import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type {
  AutomatedSenderPolicies,
  AutomatedSenderPolicyMode,
  Bot,
  ExternalConversation,
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
import type { NativeStackNavigationOptions } from "expo-router";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { glassHeaderOptions } from "../../components/glass-title";
import { LoadFailure } from "../../components/load-failure";
import { MenuPickerMenu } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { native, useMobileTokens, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import { errorText } from "../../lib/user-error";

/** Reply mode, instructions, and automated-sender handling for one team chat room. */
export default function TeamConversationSettings() {
  const { t } = useLingui();
  const router = useRouter();
  const navigation = useNavigation();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const [loaded, setLoaded] = useState<{ conversation: ExternalConversation; bot: Bot } | null>(
    null,
  );
  const [mode, setMode] = useState<ListenMode>("inherit");
  const [rules, setRules] = useState<string | null>(null);
  const [policies, setPolicies] = useState<AutomatedSenderPolicies>({});
  // Typed hours stay a draft until saved, so Save works while the field still has focus.
  const [hoursDrafts, setHoursDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const saveRef = useRef(async () => {});
  const title = loaded ? loaded.conversation.displayName || t`External conversation` : "";

  useEffect(() => {
    let active = true;
    void Promise.all([rpc("spaces/list"), rpc("bots/list")])
      .then(([navigation, bots]) => {
        const conversation = navigation.current.externalConversations.find(
          (candidate) => candidate.id === conversationId,
        );
        const bot = bots.find((candidate) => candidate.id === conversation?.botId);
        if (!active || !conversation || !bot) return;
        setLoaded({ conversation, bot });
        setMode(listenMode(conversation.teamChatAmbientEnabled));
        setRules(conversation.teamChatRules || null);
        setPolicies(conversation.automatedSenderPolicies);
        setLoadError(null);
      })
      .catch((err) => {
        if (active) setLoadError(errorText(err));
      });
    return () => {
      active = false;
    };
  }, [attempt, conversationId]);

  useLayoutEffect(() => {
    navigation.setOptions({
      ...glassHeaderOptions(title),
      ...(!loaded
        ? { headerRight: undefined, unstable_headerRightItems: undefined }
        : iosAtLeast(26)
          ? {
              unstable_headerRightItems: () => [
                {
                  type: "button" as const,
                  label: t`Save`,
                  variant: "prominent" as const,
                  tintColor: mobileTokens().primary,
                  disabled: saving,
                  onPress: () => void saveRef.current(),
                },
              ],
            }
          : {
              headerRight: () => (
                <NativeActionButton
                  disabled={saving}
                  fill={false}
                  label={t`Save`}
                  onPress={() => void saveRef.current()}
                />
              ),
            }),
    } satisfies NativeStackNavigationOptions);
  }, [navigation, title, loaded, saving, t]);

  if (!loaded) {
    return loadError ? (
      <View style={styles.content}>
        <LoadFailure
          message={loadError}
          onRetry={() => {
            setLoadError(null);
            setAttempt((count) => count + 1);
          }}
        />
      </View>
    ) : null;
  }
  const { conversation, bot } = loaded;
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

  async function save() {
    setSaving(true);
    try {
      await rpc("externalConversations/updatePolicy", {
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
      router.back();
    } catch (err) {
      // Save sits in the header, so a failure needs to show where the person is looking.
      Alert.alert(errorText(err, t`Could not save`));
    } finally {
      setSaving(false);
    }
  }
  saveRef.current = save;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      automaticallyAdjustKeyboardInsets
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
                    withSenderMode(current, sender, next as AutomatedSenderPolicyMode),
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
