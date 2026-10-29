import type { Me, PaymentWalletStatus } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, AppState, Linking, ScrollView, StyleSheet, View } from "react-native";
import { LoadFailure } from "../../components/load-failure";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/** How often an open sign-in asks whether the provider finished it. */
export const WALLET_POLL_MS = 3_000;

type Provider = NonNullable<Me["paymentWalletProvider"]>;

/** Connects the wallet the user's bots spend from. */
export default function WalletSettings() {
  const { t } = useI18n();
  const sideInsets = useSideInsets();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [status, setStatus] = useState<PaymentWalletStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Bumped by connect and disconnect, so a read started before one cannot overwrite its result.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const started = generation.current;
    const [me, next] = await Promise.all([rpc("me"), rpc("paymentWallet/status")]);
    setProvider(me.paymentWalletProvider ?? null);
    if (started === generation.current) setStatus(next);
    setLoadError(null);
  }, []);
  const reload = useCallback(
    () => void load().catch((err) => setLoadError(errorText(err, t("Could not load wallet")))),
    [load, t],
  );

  // Returning from the provider's page reads again, which also finishes the sign-in.
  useFocusEffect(
    useCallback(() => {
      reload();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") reload();
      });
      return () => subscription.remove();
    }, [reload]),
  );

  // Each read of an open sign-in advances it; stops once it settles or the screen closes.
  const connecting = status?.status === "connecting";
  useFocusEffect(
    useCallback(() => {
      if (!connecting) return;
      let active = true;
      const timer = setInterval(() => {
        const started = generation.current;
        void rpc("paymentWallet/status")
          .then((next) => {
            if (active && started === generation.current) setStatus(next);
          })
          .catch(() => undefined);
      }, WALLET_POLL_MS);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [connecting]),
  );

  async function act(action: () => Promise<PaymentWalletStatus>) {
    if (pending) return;
    setPending(true);
    generation.current += 1;
    try {
      const next = await action();
      setStatus(next);
      if (next.status === "connecting") await Linking.openURL(next.verificationUrl);
    } catch (err) {
      Alert.alert(errorText(err, t("Could not update wallet")));
    } finally {
      setPending(false);
    }
  }

  const disconnect = () => void act(() => rpc("paymentWallet/disconnect"));

  return (
    <ScrollView style={sideInsets} contentInsetAdjustmentBehavior="automatic">
      {loadError && !status ? (
        <View style={styles.failure}>
          <LoadFailure message={loadError} onRetry={reload} />
        </View>
      ) : null}
      {provider && status ? (
        <SettingsGroup>
          {status.status === "disconnected" ? (
            <SettingsRow
              accessibilityRole="button"
              disabled={pending}
              onPress={() => void act(() => rpc("paymentWallet/connect"))}
              title={t("Connect {name}", { name: provider.name })}
            />
          ) : (
            <SettingsRow
              title={provider.name}
              value={status.status === "connecting" ? status.userCode : undefined}
            />
          )}
          {status.status === "connecting" ? (
            <>
              <SettingsRow
                accessibilityRole="button"
                disabled={pending}
                onPress={() => void Linking.openURL(status.verificationUrl)}
                title={t("Open")}
              />
              <SettingsRow
                accessibilityRole="button"
                disabled={pending}
                onPress={disconnect}
                title={t("Cancel")}
              />
            </>
          ) : null}
          {status.status === "connected" ? (
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
          ) : null}
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ failure: { padding: 16 } });
