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
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { glassHeaderOptions } from "../../components/glass-title";
import { LoadFailure } from "../../components/load-failure";
import { MenuPickerMenu } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useMobileTokens, useThemedStyles } from "../../lib/native";
import { errorText } from "../../lib/user-error";

/** Listening, guidance, and automated-sender handling for one team chat room. */
export default function TeamConversationSettings() {
  const { t } = useI18n();
  const router = useRouter();
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
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

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
        setRules(conversation.teamChatRules);
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
  const senderModeLabels: Record<AutomatedSenderPolicyMode, string> = {
    ignore: t("Ignore"),
    rollup: t("Group updates"),
    action: t("Always act"),
    user: t("Treat like a person"),
  };

  async function save() {
    setSaving(true);
    setError(null);
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
      setError(errorText(err, t("Could not save")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={glassHeaderOptions(conversation.displayName || t("External conversation"))}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <SettingsGroup
          label={t("Listening")}
          footer={
            listening
              ? undefined
              : t("{bot} will still respond to direct mentions.", { bot: bot.name })
          }
        >
          <View style={styles.padded}>
            <NativeSegmentedControl
              accessibilityLabel={t("Listening")}
              value={mode}
              onChange={setMode}
              options={[
                { value: "inherit", label: t("{bot} default", { bot: bot.name }) },
                { value: "listen", label: t("Listen") },
                { value: "mentions", label: t("Mentions only") },
              ]}
            />
          </View>
        </SettingsGroup>
        <View>
          <View style={styles.labelRow}>
            <Text style={styles.label}>{t("Room guidance")}</Text>
            {rules !== null ? (
              <NativeActionButton
                label={t("Use default guidance")}
                prominence="quiet"
                variant="text"
                size="compact"
                fill={false}
                onPress={() => setRules(null)}
              />
            ) : (
              <Text style={styles.hint}>{t("{bot} default", { bot: bot.name })}</Text>
            )}
          </View>
          <TextInput
            accessibilityLabel={t("Room guidance")}
            value={rules ?? bot.teamChatRules}
            onChangeText={setRules}
            maxLength={4000}
            multiline
            placeholder={t("Engage when... Ignore...")}
            placeholderTextColor={tokens.mutedForeground}
            style={[styles.input, { color: tokens.foreground }]}
          />
        </View>
        <SettingsGroup
          label={t("Automated senders")}
          footer={
            senders.length ? undefined : t("Automated senders will appear after they post here.")
          }
        >
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
                title={t("Every")}
                trailing={
                  <View style={styles.hours}>
                    <TextInput
                      accessibilityLabel={t("{sender} rollup hours", { sender: sender.name })}
                      keyboardType="number-pad"
                      value={hoursDrafts[sender.id] ?? String(policy.rollupHours ?? 6)}
                      onChangeText={(text) =>
                        setHoursDrafts((current) => ({ ...current, [sender.id]: text }))
                      }
                      style={[styles.hoursInput, { color: tokens.foreground }]}
                    />
                    <Text style={styles.hint}>{t("hours")}</Text>
                  </View>
                }
              />,
            ];
          })}
        </SettingsGroup>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <NativeActionButton
          label={saving ? t("Saving…") : t("Save")}
          disabled={saving}
          onPress={() => void save()}
        />
      </ScrollView>
    </>
  );
}

function createStyles() {
  return StyleSheet.create({
    content: { padding: 16, gap: 20 },
    padded: { padding: 12 },
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
    error: { color: mobileTokens().destructive, padding: 12 },
  });
}
