import type { CloudAgentCredentialStatus, Me } from "@rakazo/contracts";
import { useFocusEffect, useNavigation } from "expo-router";
import { useCallback, useLayoutEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { glassHeaderOptions } from "../../components/glass-title";
import { LoadFailure } from "../../components/load-failure";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

type Provider = NonNullable<Me["cloudAgentProvider"]>;

/** Saves the signed-in user's cloud-agent key. The key is never shown again. */
export default function CloudAgentSettings() {
  const { t } = useI18n();
  const sideInsets = useSideInsets();
  const navigation = useNavigation();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [status, setStatus] = useState<CloudAgentCredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const [me, next] = await Promise.all([rpc("me"), rpc("cloudAgentCredential/status")]);
    setProvider(me.cloudAgentProvider ?? null);
    setStatus(next);
    setLoadError(null);
  }, []);
  const reload = useCallback(
    () => void load().catch((err) => setLoadError(errorText(err, t("Could not load key")))),
    [load, t],
  );

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  useLayoutEffect(() => {
    navigation.setOptions(glassHeaderOptions(provider?.name ?? ""));
  }, [navigation, provider?.name]);

  async function act(action: () => Promise<CloudAgentCredentialStatus>) {
    if (pending) return;
    setPending(true);
    try {
      setStatus(await action());
      setApiKey("");
    } catch (err) {
      Alert.alert(errorText(err, t("Could not save key")));
    } finally {
      setPending(false);
    }
  }

  const disconnect = () => void act(() => rpc("cloudAgentCredential/disconnect"));

  return (
    <ScrollView style={sideInsets} contentInsetAdjustmentBehavior="automatic">
      {loadError && !status ? (
        <View style={styles.failure}>
          <LoadFailure message={loadError} onRetry={reload} />
        </View>
      ) : null}
      {provider && status?.status === "disconnected" ? (
        <SettingsGroup>
          <SettingsInputRow
            accessibilityLabel={t("API key")}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            importantForAutofill="no"
            secureTextEntry
            value={apiKey}
            editable={!pending}
            onChangeText={setApiKey}
          />
          <SettingsRow
            accessibilityRole="button"
            disabled={pending || !apiKey.trim()}
            onPress={() => void act(() => rpc("cloudAgentCredential/connect", { apiKey }))}
            title={t("Connect {name}", { name: provider.name })}
          />
        </SettingsGroup>
      ) : null}
      {provider && status?.status === "connected" ? (
        <SettingsGroup>
          <SettingsRow title={provider.name} />
          <SettingsRow
            accessibilityRole="button"
            destructive
            disabled={pending}
            onPress={() =>
              Alert.alert(t("Disconnect {name}?", { name: provider.name }), undefined, [
                { text: t("Cancel"), style: "cancel" },
                { text: t("Disconnect"), style: "destructive", onPress: disconnect },
              ])
            }
            title={t("Disconnect")}
          />
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ failure: { padding: 16 } });
