import type { McpServer } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

/** Saves a client registered with the server's sign-in provider, for providers that cannot
 * register Rakazo themselves. `onSaved` signs in and reports its own errors, because the saved
 * client removes this form. */
export function McpOAuthClientForm({
  server,
  onSaved,
}: {
  server: McpServer;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc("integrationSetup/get")
      .then(({ webUrl }) => {
        if (!cancelled) setRedirectUri(new URL("/mcp/oauth/callback", webUrl).toString());
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!server.endpoint || server.transport === "stdio") return null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await rpc("mcp/servers/update", {
        id: server.id,
        oauthClient: { clientId: clientId.trim(), clientSecret: clientSecret || undefined },
      });
    } catch (reason) {
      setError(errorText(reason, t("Could not connect")));
      setBusy(false);
      return;
    }
    await onSaved();
    setBusy(false);
  }

  return (
    <View testID="mcp-oauth-client-form" style={styles.form}>
      <TextInput
        value={clientId}
        onChangeText={setClientId}
        accessibilityLabel={t("Client ID")}
        placeholder={t("Client ID")}
        placeholderTextColor={native.tertiaryLabel}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <TextInput
        value={clientSecret}
        onChangeText={setClientSecret}
        accessibilityLabel={t("Client secret")}
        placeholder={t("Client secret")}
        placeholderTextColor={native.tertiaryLabel}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={styles.input}
      />
      {redirectUri ? (
        <View style={styles.redirect}>
          <Text style={styles.label}>{t("Redirect URI")}</Text>
          <Text selectable style={styles.value}>
            {redirectUri}
          </Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <NativeActionButton
        label={t("Sign in")}
        busy={busy}
        disabled={busy || !clientId.trim()}
        onPress={() => void save()}
      />
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    form: { gap: 8 },
    input: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 14,
      fontSize: 15,
    },
    redirect: { gap: 2 },
    label: { color: native.secondaryLabel, fontSize: 13 },
    value: { color: native.label, fontSize: 13 },
    error: { color: mobileTokens().destructive, fontSize: 14 },
  });
}
