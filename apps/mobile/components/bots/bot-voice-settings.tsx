import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { BotVoiceSelection } from "@rakazo/core";
import { botVoiceChoices, botVoiceProviderChoices, botVoiceSelection } from "@rakazo/core";
import { writeSaved } from "@rakazo/core/query";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { captureApiRequestContext, selectedSpaceId } from "../../lib/api/api";
import { errorText } from "../../lib/api/user-error";
import { queryClient, rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { createSpeechOwner, speakText, stopSpeaking } from "../../lib/voice/voice";
import { NativeActionButton } from "../native/native-action-button";
import { SettingsGroup, SettingsRow } from "../settings/settings-group";
import { MenuPicker } from "../ui/menu-picker";

/** Hosted bot choices stay separate from this phone's Device voice preference. */
export function BotVoiceSettings({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [owner] = useState(createSpeechOwner);
  const cancelled = useRef(false);
  useFocusEffect(
    useCallback(
      () => () => {
        cancelled.current = true;
        stopSpeaking(owner);
      },
      [owner],
    ),
  );
  const botRead = rpcQuery("bots/get", { botId });
  const botQuery = useScreenQuery(botRead);
  const catalog = useScreenQuery(rpcQuery("voice/catalog"));
  const credentials = useScreenQuery(rpcQuery("voice/credentials"));
  const statusRead = rpcQuery("voice/status", { botId });
  const status = useScreenQuery(statusRead);
  const bot = botQuery.data;
  const providers = botVoiceProviderChoices({
    provider: bot?.voiceProvider,
    credentials: credentials.data,
    catalog: catalog.data,
    unavailableLabel: t`Unavailable`,
  });
  const provider = bot?.voiceProvider ?? providers.connection?.provider ?? "";
  const voices = useScreenQuery(rpcQuery("voice/voices", { provider }), {
    enabled: Boolean(providers.connection),
  });
  const change = useSave({
    save: async (patch: BotVoiceSelection, send) => {
      const updated = await send("bots/update", { botId, ...patch });
      await writeSaved(queryClient, botRead.queryKey, () => updated);
    },
    stale: [statusRead.queryKey],
  });
  const sample = useSave({
    save: async () => {
      cancelled.current = false;
      const requestContext = await captureApiRequestContext();
      if (
        cancelled.current ||
        (requestContext.headers["x-rakazo-space-id"] ?? "") !== (selectedSpaceId() ?? "")
      ) {
        return;
      }
      const name = bot?.name.trim();
      const spoken = await speakText(
        name ? t`Hi, I'm ${ph({ name })}.` : t`Hi, this is how I'll sound.`,
        {
          botId,
          hostedPreview: true,
          requestContext,
          owner,
        },
      );
      if (!spoken && !cancelled.current) throw new Error(t`Could not play that sample.`);
    },
  });
  const busy = change.pending || sample.pending || !bot;
  const providerDefault = providers.defaultLabel
    ? t`Default (${providers.defaultLabel})`
    : t`Default`;
  const voiceChoices = botVoiceChoices({
    voices: voices.data,
    voiceId: bot?.voiceId,
    defaultVoiceId: providers.connection?.voiceId,
    unavailableLabel: t`Unavailable`,
  });
  const voiceDefault = voiceChoices.defaultLabel
    ? t`Default (${voiceChoices.defaultLabel})`
    : t`Default`;
  const failure =
    change.error ??
    sample.error ??
    botQuery.error ??
    catalog.error ??
    credentials.error ??
    status.error ??
    voices.error;
  const needsReconnect = Boolean(credentials.data && bot?.voiceProvider && !providers.connection);

  if (catalog.isPending) return null;
  if (!failure && credentials.data && providers.options.length === 0 && !status.data?.ready)
    return null;

  return (
    <SettingsGroup
      label={t`Voice`}
      footer={
        failure
          ? errorText(failure)
          : needsReconnect
            ? t`Reconnect this provider in Settings → Voice.`
            : undefined
      }
    >
      {providers.options.length === 0 ? (
        <SettingsRow title={t`Provider`} value={t`Default`} />
      ) : (
        <MenuPicker
          label={t`Provider`}
          choices={[
            { key: "", label: providerDefault },
            ...providers.options.map((choice) => ({ key: choice.value, label: choice.label })),
          ]}
          value={bot?.voiceProvider ?? ""}
          disabled={busy || !catalog.data || !credentials.data}
          onChange={(key) => {
            if (key !== (bot?.voiceProvider ?? "")) {
              sample.reset();
              change.run(
                botVoiceSelection({
                  provider: key || null,
                  currentProvider: bot?.voiceProvider,
                  ...(key ? {} : { voiceId: null }),
                }),
              );
            }
          }}
        />
      )}
      {provider || status.data?.ready ? (
        <View style={styles.voiceRow}>
          <View style={styles.voicePicker}>
            {!providers.connection && !bot?.voiceProvider ? (
              <SettingsRow title={t`Voice`} value={t`Default`} />
            ) : (
              <MenuPicker
                label={t`Voice`}
                choices={[
                  { key: "", label: voiceDefault },
                  ...voiceChoices.options.map((choice) => ({
                    key: choice.value,
                    label: choice.label,
                  })),
                ]}
                value={bot?.voiceId ?? ""}
                disabled={busy || !providers.connection || !voices.data}
                onChange={(key) => {
                  if (key !== (bot?.voiceId ?? "")) {
                    sample.reset();
                    change.run(
                      botVoiceSelection({
                        currentProvider: bot?.voiceProvider,
                        defaultProvider: providers.connection?.provider,
                        voiceId: key || null,
                      }),
                    );
                  }
                }}
              />
            )}
          </View>
          <NativeActionButton
            accessibilityLabel={sample.pending ? t`Stop` : t`Hear a sample`}
            prominence="plain"
            icon={{
              ios: sample.pending ? "stop.fill" : "play.fill",
              android: sample.pending ? "stop" : "play",
            }}
            disabled={change.pending || !bot || needsReconnect || !status.data?.ready}
            onPress={() => {
              if (sample.pending) {
                cancelled.current = true;
                stopSpeaking(owner);
              } else sample.run();
            }}
          />
        </View>
      ) : null}
    </SettingsGroup>
  );
}

const styles = StyleSheet.create({
  voiceRow: { flexDirection: "row", alignItems: "center", paddingRight: 8 },
  voicePicker: { flex: 1, minWidth: 0 },
});
