import type { AiConsentStatus } from "@rakazo/contracts";
import { AI_DATA_DISCLOSURES, AI_PRIVACY_URL } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Alert, Button, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { promptAiConsent } from "../lib/ai-consent";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";

export default function AiDataSharing() {
  const [status, setStatus] = useState<AiConsentStatus | null>(null);
  const [pending, setPending] = useState(false);
  const tokens = mobileTokens();
  const error = (cause: unknown) =>
    Alert.alert(
      "AI data sharing",
      cause instanceof Error ? cause.message : "Could not load permissions.",
    );
  useEffect(() => {
    void rpc<AiConsentStatus>("aiConsent/status").then(setStatus).catch(error);
  }, []);
  return (
    <ScrollView contentContainerStyle={styles.container}>
      {status?.recipients.map((recipient) => (
        <View key={recipient.key} style={styles.recipient}>
          <Text style={[styles.title, { color: tokens.foreground }]}>{recipient.name}</Text>
          {recipient.detail ? (
            <Text style={{ color: tokens.mutedForeground }}>{recipient.detail}</Text>
          ) : null}
          <Text style={{ color: tokens.foreground }}>{AI_DATA_DISCLOSURES[recipient.use]}</Text>
          {recipient.privacyUrl ? (
            <Button
              color={tokens.primary}
              title="Provider privacy policy"
              onPress={() => void Linking.openURL(recipient.privacyUrl!)}
            />
          ) : null}
          <Button
            color={tokens.primary}
            title={recipient.allowed ? "Withdraw mobile permission" : "Allow on mobile"}
            disabled={pending}
            onPress={() => {
              setPending(true);
              void (async () => {
                if (recipient.allowed)
                  setStatus(await rpc("aiConsent/revoke", { key: recipient.key }));
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
            }}
          />
        </View>
      ))}
      {status?.recipients.length === 0 ? (
        <Text style={{ color: tokens.foreground }}>No AI services configured.</Text>
      ) : null}
      <Text style={{ color: tokens.mutedForeground }}>
        Withdrawal applies to new mobile actions. Stop existing runs and disable routines
        separately.
      </Text>
      <Button
        color={tokens.primary}
        title="Withdraw all mobile permissions"
        disabled={pending}
        onPress={() => {
          setPending(true);
          void rpc<AiConsentStatus>("aiConsent/revoke", { key: null })
            .then(setStatus)
            .catch(error)
            .finally(() => setPending(false));
        }}
      />
      <Button
        color={tokens.primary}
        title="Privacy policy"
        onPress={() => void Linking.openURL(status?.privacyUrl ?? AI_PRIVACY_URL)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 24 },
  recipient: { gap: 10 },
  title: { fontSize: 18, fontWeight: "600" },
});
