import type { Bot, MessagingInstallationsStatus, MessagingStatus } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { errorText } from "../../lib/user-error";

export default function MessagingSettings() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState("");
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  const [installations, setInstallations] = useState<MessagingInstallationsStatus>({
    available: false,
    installations: [],
  });
  const [link, setLink] = useState<{ code: string; expiresAt: string; botId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const [nextBots, nextStatus, nextInstallations] = await Promise.all([
      rpc<Bot[]>("bots/list"),
      rpc<MessagingStatus>("messaging/status"),
      rpc<MessagingInstallationsStatus>("messaging/installations/list"),
    ]);
    setBots(nextBots);
    setStatus(nextStatus);
    setInstallations(nextInstallations);
  }, []);
  useFocusEffect(
    useCallback(() => {
      void refresh().catch((err) => setError(errorText(err)));
    }, [refresh]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh().catch((err) => setError(errorText(err)));
    });
    return () => subscription.remove();
  }, [refresh]);

  useEffect(() => {
    if (!link) return;
    if (status?.identities.some((identity) => identity.botId === link.botId)) {
      setLink(null);
      return;
    }
    const timer = setTimeout(
      () => setLink(null),
      Math.max(0, Date.parse(link.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [link, status]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setLink(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <SettingsGroup>
        <MenuPicker
          label={t("Bot")}
          choices={[
            { key: "", label: t("Choose a bot…") },
            ...bots.map((bot) => ({ key: bot.id, label: bot.name })),
          ]}
          value={botId}
          onChange={(id) => {
            setBotId(id);
            setLink(null);
          }}
        />
        {status?.enabled ? (
          <View style={styles.action}>
            <NativeActionButton
              label={t("Link a chat app")}
              disabled={!botId || busy}
              onPress={() =>
                void act(async () => {
                  const issued = await rpc<{ code: string; expiresAt: string }>(
                    "messaging/link/start",
                    { botId },
                  );
                  setLink({ ...issued, botId });
                })
              }
            />
          </View>
        ) : null}
        {installations.available ? (
          <View style={styles.action}>
            <NativeActionButton
              label={t("Connect Slack workspace")}
              disabled={!botId || busy}
              onPress={() =>
                void act(async () => {
                  const { url } = await rpc<{ url: string }>("messaging/installations/start", {
                    botId,
                  });
                  await Linking.openURL(url);
                })
              }
            />
          </View>
        ) : null}
      </SettingsGroup>
      {link && Date.parse(link.expiresAt) > Date.now() ? (
        <Text selectable style={styles.code}>
          {t("Send {code} to the chat app in a direct message within 10 minutes.", {
            code: link.code,
          })}
        </Text>
      ) : null}
      {installations.installations.map((installation) => (
        <SettingsGroup key={installation.id}>
          <SettingsRow
            title={installation.workspaceName}
            value={bots.find((bot) => bot.id === installation.botId)?.name}
          />
          <View style={styles.action}>
            <NativeActionButton
              label={t("Disconnect")}
              prominence="destructive"
              disabled={busy}
              onPress={() =>
                void act(() => rpc("messaging/installations/remove", { id: installation.id }))
              }
            />
          </View>
        </SettingsGroup>
      ))}
      {status?.identities.map((identity) => (
        <SettingsGroup key={identity.id}>
          <SettingsRow title={identity.botName} value={identity.provider} />
          <View style={styles.action}>
            <NativeActionButton
              label={t("Unlink")}
              prominence="destructive"
              disabled={busy}
              onPress={() =>
                void act(() => rpc("messaging/identities/unlink", { identityId: identity.id }))
              }
            />
          </View>
        </SettingsGroup>
      ))}
    </ScrollView>
  );
}
function createStyles() {
  return StyleSheet.create({
    content: { padding: 16, gap: 16 },
    action: { padding: 12 },
    code: { color: native.label, padding: 12 },
    error: { color: mobileTokens().destructive, padding: 12 },
  });
}
