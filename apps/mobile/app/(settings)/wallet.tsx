import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { writeSaved } from "@rakazo/core/query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, ScrollView, StyleSheet } from "react-native";
import {
  SettingsGroup,
  SettingsRow,
  useStackedSettings,
} from "../../components/settings/settings-group";
import { LoadFailure } from "../../components/ui/load-failure";
import { errorText } from "../../lib/api/user-error";
import { useSideInsets } from "../../lib/layout/side-insets";
import { openExternalUrl } from "../../lib/platform/open-url";
import { accountRpcQuery, formRead, queryClient, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";

/** How often an open sign-in asks whether the provider finished it. */
export const WALLET_POLL_MS = 3_000;

/** Connects the wallet the user's bots spend from. */
export default function WalletSettings() {
  const { t } = useLingui();
  const sideInsets = useSideInsets();
  const stacked = useStackedSettings();
  // Connect, cancel and disconnect are offered from the status on screen, so each visit reads it
  // afresh. Returning from the provider's page reads again, which also finishes the sign-in.
  const statusRead = formRead(accountRpcQuery("paymentWallet/status"));
  const meQuery = useScreenQuery(formRead(accountRpcQuery("me")));
  const statusQuery = useScreenQuery(statusRead);
  const me = meQuery.data;
  const provider = me?.paymentWalletProvider ?? null;
  // A copy an earlier visit left is not what an action may be offered from.
  const status = (statusQuery.isFetchedAfterMount && statusQuery.data) || null;
  const readError = meQuery.error ?? statusQuery.error;
  const loaded = Boolean(me && status);
  // A failed read stays on screen while its retry is in flight, until that one answers.
  const [loadFailure, setLoadFailure] = useState<Error | null>(null);
  useEffect(() => {
    if (readError) setLoadFailure(readError);
    else if (loaded) setLoadFailure(null);
  }, [readError, loaded]);
  const { refetch: readMe } = meQuery;
  const { refetch: readStatus } = statusQuery;
  const reload = () => {
    void readMe();
    void readStatus();
  };

  // Each read of an open sign-in advances it; stops once it settles or the screen closes.
  const connecting = status?.status === "connecting";
  useFocusEffect(
    useCallback(() => {
      if (!connecting) return;
      const timer = setInterval(() => void readStatus({ cancelRefetch: false }), WALLET_POLL_MS);
      return () => clearInterval(timer);
    }, [connecting, readStatus]),
  );

  const change = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (action: "connect" | "disconnect", send) => {
      const next = await send(`paymentWallet/${action}`, undefined);
      // A read that started before the change never puts back what it replaced.
      await writeSaved(queryClient, statusRead.queryKey, () => next);
      if (next.status === "connecting") await Linking.openURL(next.verificationUrl);
    },
    onFailed: (err) => Alert.alert(errorText(err, t`Could not update wallet`)),
  });
  const pending = change.pending;
  const disconnect = () => change.run("disconnect");

  return (
    <ScrollView
      style={sideInsets}
      contentContainerStyle={[styles.content, stacked && styles.compactContent]}
      contentInsetAdjustmentBehavior="automatic"
    >
      {loadFailure && !loaded ? (
        <LoadFailure message={errorText(loadFailure, t`Could not load wallet`)} onRetry={reload} />
      ) : null}
      {provider && status ? (
        <SettingsGroup>
          {status.status === "disconnected" ? (
            <SettingsRow
              accessibilityRole="button"
              disabled={pending}
              onPress={() => change.run("connect")}
              title={t`Connect ${ph({ name: provider.name })}`}
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
                onPress={() => void openExternalUrl(status.verificationUrl)}
                title={t`Open`}
              />
              <SettingsRow
                accessibilityRole="button"
                disabled={pending}
                onPress={disconnect}
                title={t`Cancel`}
              />
            </>
          ) : null}
          {status.status === "connected" ? (
            <SettingsRow
              accessibilityRole="button"
              destructive
              disabled={pending}
              onPress={() =>
                Alert.alert(t`Disconnect ${ph({ name: provider.name })}?`, undefined, [
                  { text: t`Cancel`, style: "cancel" },
                  { text: t`Disconnect`, style: "destructive", onPress: disconnect },
                ])
              }
              title={t`Disconnect`}
            />
          ) : null}
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },
  compactContent: { paddingHorizontal: 8 },
});
