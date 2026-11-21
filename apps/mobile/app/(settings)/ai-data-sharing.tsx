import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { AiRecipient } from "@rakazo/contracts";
import { AI_PRIVACY_URL } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import { useIsFocused } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet } from "react-native";
import {
  SettingsFooter,
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
  useStackedSettings,
} from "../../components/settings/settings-group";
import { errorText } from "../../lib/api/user-error";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { openExternalUrl } from "../../lib/platform/open-url";
import { queryClient, rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { aiDataDisclosure, promptAiConsent } from "../../lib/settings/ai-consent";
import {
  aiDataSharingPlaceholder,
  aiPrivacyLinks,
  groupAiRecipients,
} from "../../lib/settings/ai-data-sharing";

export default function AiDataSharing() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const statusRead = rpcQuery("aiConsent/status");
  // Read on every visit: a consent prompt elsewhere, or another device, can change it meanwhile.
  const { data, error: loadError, refetch } = useScreenQuery(statusRead);
  const status = data ?? null;
  const placeholder = aiDataSharingPlaceholder(status, Boolean(loadError));
  const styles = useThemedStyles(createStyles);
  const stacked = useStackedSettings();
  // A read can fail while another screen covers this one; its alert waits for the return.
  const focused = useIsFocused();
  useEffect(() => {
    if (!loadError || !focused) return;
    Alert.alert(t`AI data sharing`, errorText(loadError, t`Could not load permissions.`), [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Retry`, onPress: () => void refetch() },
    ]);
  }, [loadError, focused, refetch, t]);

  const change = useSave({
    save: async (ask: { recipient: AiRecipient; allowed: boolean } | "withdraw", send) => {
      if (!status) return;
      const saved =
        ask === "withdraw"
          ? await send("aiConsent/revoke", { key: null })
          : !ask.allowed
            ? await send("aiConsent/revoke", { key: ask.recipient.key })
            : (await promptAiConsent(ask.recipient))
              ? await send("aiConsent/allow", {
                  scope: status.scope,
                  version: status.version,
                  keys: [ask.recipient.key],
                })
              : null;
      // A read that started before the change never puts back what it replaced.
      if (saved) await writeSaved(queryClient, statusRead.queryKey, () => saved);
    },
    onFailed: (cause) =>
      Alert.alert(t`AI data sharing`, errorText(cause, t`Could not load permissions.`)),
  });
  const pending = change.pending;

  function requestWithdrawal() {
    Alert.alert(
      t`Withdraw all permissions?`,
      t`New mobile actions won't send data to these services. Runs already in progress and routines keep going until you stop them.`,
      [
        { text: t`Cancel`, style: "cancel" },
        { text: t`Withdraw`, style: "destructive", onPress: () => change.run("withdraw") },
      ],
    );
  }

  return (
    <ScrollView
      style={[styles.screen, sideInsets]}
      contentContainerStyle={[styles.container, stacked && styles.compactContainer]}
      contentInsetAdjustmentBehavior="automatic"
    >
      {placeholder === "loading" && <ActivityIndicator />}
      {placeholder === "failed" && (
        <SettingsFooter>{t`Could not load permissions.`}</SettingsFooter>
      )}
      {placeholder === "empty" && <SettingsFooter>{t`No AI services configured.`}</SettingsFooter>}
      {status && (
        <>
          {groupAiRecipients(status.recipients).map(({ use, recipients }) => (
            <SettingsGroup
              key={use}
              label={use === "model" ? t`AI models` : use === "voice" ? t`Voice` : t`Memory`}
              footer={aiDataDisclosure(use)}
            >
              {recipients.map((recipient) => (
                <SettingsSwitch
                  key={recipient.key}
                  label={recipient.name}
                  detail={recipient.detail}
                  accessibilityLabel={t`Allow ${ph({ name: recipient.name })} on mobile`}
                  disabled={pending}
                  onChange={(allowed) => change.run({ recipient, allowed })}
                  value={recipient.allowed}
                />
              ))}
            </SettingsGroup>
          ))}
          <SettingsGroup label={t`Privacy policies`}>
            {aiPrivacyLinks(status.recipients).map(({ name, url }) => (
              <SettingsRow
                key={JSON.stringify([name, url])}
                title={name}
                accessibilityRole="link"
                chevron="right"
                onPress={() => void openExternalUrl(url)}
              />
            ))}
            <SettingsRow
              title={t`Rakazo`}
              accessibilityRole="link"
              chevron="right"
              onPress={() => void openExternalUrl(status.privacyUrl ?? AI_PRIVACY_URL)}
            />
          </SettingsGroup>
          <SettingsGroup>
            <SettingsRow
              accessibilityRole="button"
              destructive
              dimmed={pending}
              disabled={pending}
              onPress={requestWithdrawal}
              title={t`Withdraw all permissions`}
            />
          </SettingsGroup>
        </>
      )}
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    container: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 28 },
    compactContainer: { paddingHorizontal: 8 },
  });
}
