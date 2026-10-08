import type { IntegrationSetupState } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSegmentedControl } from "../components/native-segmented-control";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

export default function IntegrationSetup() {
  const router = useRouter();
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [state, setState] = useState<IntegrationSetupState | null>(null);
  const [choice, setChoice] = useState("direct");
  const [key, setKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void rpc<IntegrationSetupState>("integrationSetup/get")
      .then((setup) => {
        if (!setup.canConfigure) {
          router.replace("/integrations");
          return;
        }
        setState(setup);
      })
      .catch(() => setError(t("Could not load integrations")));
  }, []);
  const choices = [
    { value: "direct", label: t("Direct MCP") },
    { value: "composio", label: "Composio" },
    { value: "pipedream", label: "Pipedream" },
    { value: "executor", label: "Executor" },
  ];
  const managed = choice === "composio" || choice === "pipedream";
  const configured = state?.providers.find((provider) => provider.id === choice)?.configured;
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await rpc(
        "integrationSetup/save",
        choice === "composio"
          ? { provider: "composio", apiKey: key }
          : {
              provider: "pipedream",
              clientId,
              clientSecret: key,
              projectId,
              environment: "production",
            },
      );
      setKey("");
      router.replace("/integrations");
    } catch {
      setError(t("Could not verify or save these credentials"));
    } finally {
      setBusy(false);
    }
  }
  function button(label: string, onPress: () => void, disabled = false) {
    return (
      <NativeActionButton
        disabled={disabled}
        fill
        label={label}
        onPress={onPress}
        prominence="secondary"
      />
    );
  }
  if (!state) {
    return (
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        {error ? (
          <Text accessibilityRole="alert" style={styles.text}>
            {error}
          </Text>
        ) : (
          <ActivityIndicator />
        )}
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <NativeSegmentedControl
        accessibilityLabel={t("Server integrations")}
        disabled={busy}
        onChange={(next) => {
          setChoice(next);
          setKey("");
          setError(null);
        }}
        options={choices}
        value={choice}
      />
      {choice === "composio" || choice === "pipedream" ? (
        <>
          {configured ? <Text style={styles.text}>{t("Connected")}</Text> : null}
          {state?.canConfigure ? (
            <>
              {choice === "pipedream" ? (
                <>
                  <Text style={styles.text}>{t("Client ID")}</Text>
                  <TextInput
                    accessibilityLabel={t("Client ID")}
                    value={clientId}
                    onChangeText={setClientId}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                  <Text style={styles.text}>{t("Project ID")}</Text>
                  <TextInput
                    accessibilityLabel={t("Project ID")}
                    value={projectId}
                    onChangeText={setProjectId}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                </>
              ) : null}
              <Text style={styles.text}>
                {choice === "composio" ? t("API key") : t("Client secret")}
              </Text>
              <TextInput
                accessibilityLabel={choice === "composio" ? t("API key") : t("Client secret")}
                value={key}
                onChangeText={setKey}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              {button(t("Get credentials"), () => {
                void Linking.openURL(
                  choice === "composio"
                    ? "https://dashboard.composio.dev"
                    : "https://pipedream.com/docs/connect/mcp/developers",
                );
              })}
            </>
          ) : state && !configured ? (
            <Text style={styles.text}>{t("Ask the server owner to configure this provider.")}</Text>
          ) : null}
        </>
      ) : (
        <>
          <Text style={styles.text}>
            {choice === "executor"
              ? t("Set up Executor on your server in the web app.")
              : t("Finish MCP authorization in the web app.")}
          </Text>
          {button(
            t("Open web app"),
            () => {
              const url = new URL(state.webUrl);
              if (choice === "direct") url.searchParams.set("mode", "mcp");
              void Linking.openURL(url.toString());
            },
            !state,
          )}
        </>
      )}
      {busy ? <ActivityIndicator /> : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {button(
        t("Continue"),
        () => {
          if (managed && key.trim()) void save();
          else router.replace("/");
        },
        busy ||
          (managed &&
            state?.canConfigure &&
            !configured &&
            (!key.trim() || (choice === "pipedream" && (!clientId.trim() || !projectId.trim())))),
      )}
      {button(t("Skip"), () => router.replace("/"), busy)}
    </ScrollView>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    content: { padding: 20, gap: 16 },
    text: { color: tokens.foreground, fontSize: 16 },
    input: {
      backgroundColor: native.fill,
      borderRadius: 10,
      padding: 12,
      color: tokens.foreground,
    },
    error: { color: tokens.destructive },
  });
}
