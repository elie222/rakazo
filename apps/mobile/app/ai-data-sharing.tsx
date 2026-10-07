import type { AiConsentStatus } from "@rakazo/contracts";
import { AI_DATA_DISCLOSURES, AI_PRIVACY_URL } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSwitch } from "../components/native-switch";
import { promptAiConsent } from "../lib/ai-consent";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";

export default function AiDataSharing() {
  const { t } = useI18n();
  const [status, setStatus] = useState<AiConsentStatus | null>(null);
  const [pending, setPending] = useState(false);
  const styles = useThemedStyles(createStyles);
  const error = (cause: unknown) =>
    Alert.alert(t("AI data sharing"), errorText(cause, t("Could not load permissions.")));
  useEffect(() => {
    void rpc<AiConsentStatus>("aiConsent/status").then(setStatus).catch(error);
  }, []);

  function setAllowed(recipient: AiConsentStatus["recipients"][number], allowed: boolean) {
    if (!status) return;
    setPending(true);
    void (async () => {
      if (!allowed) setStatus(await rpc("aiConsent/revoke", { key: recipient.key }));
      else if (await promptAiConsent(recipient, status.privacyUrl))
        setStatus(
          await rpc("aiConsent/allow", {
            scope: status.scope,
            version: status.version,
            keys: [recipient.key],
          }),
        );
    })()
      .catch(error)
      .finally(() => setPending(false));
  }

  return (
    <ScrollView contentContainerStyle={styles.container} contentInsetAdjustmentBehavior="automatic">
      {status?.recipients.map((recipient) => (
        <View key={recipient.key} style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>{recipient.name}</Text>
              {recipient.detail ? <Text style={styles.detail}>{recipient.detail}</Text> : null}
            </View>
            <NativeSwitch
              accessibilityLabel={t("Allow {name} on mobile", { name: recipient.name })}
              disabled={pending}
              onValueChange={(allowed) => setAllowed(recipient, allowed)}
              value={recipient.allowed}
            />
          </View>
          <Text style={styles.body}>{AI_DATA_DISCLOSURES[recipient.use]}</Text>
          {recipient.privacyUrl ? (
            <NativeActionButton
              label={t("Provider privacy policy")}
              onPress={() => void Linking.openURL(recipient.privacyUrl!)}
              prominence="plain"
            />
          ) : null}
        </View>
      ))}
      {status?.recipients.length === 0 ? (
        <Text style={styles.detail}>{t("No AI services configured.")}</Text>
      ) : null}
      <Text style={styles.detail}>
        {t(
          "Withdrawal applies to new mobile actions. Stop existing runs and disable routines separately.",
        )}
      </Text>
      <NativeActionButton
        disabled={pending}
        label={t("Withdraw all mobile permissions")}
        onPress={() => {
          setPending(true);
          void rpc<AiConsentStatus>("aiConsent/revoke", { key: null })
            .then(setStatus)
            .catch(error)
            .finally(() => setPending(false));
        }}
        prominence="destructive"
      />
      <NativeActionButton
        label={t("Privacy policy")}
        onPress={() => void Linking.openURL(status?.privacyUrl ?? AI_PRIVACY_URL)}
        prominence="plain"
      />
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    container: { padding: 20, gap: 20 },
    card: { borderRadius: 16, backgroundColor: native.fill, padding: 18, gap: 10 },
    header: { flexDirection: "row", alignItems: "center", gap: 12 },
    headerText: { flex: 1, gap: 2 },
    title: { color: native.label, fontSize: 17, fontWeight: "600" },
    detail: { color: native.secondaryLabel, fontSize: 14 },
    body: { color: native.label, fontSize: 15, lineHeight: 21 },
  });
}
