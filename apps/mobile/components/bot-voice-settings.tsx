import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { writeSaved } from "@rakazo/core/query";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { queryClient, rpcQuery, useSave } from "../lib/query";
import { useScreenQuery } from "../lib/screen-query";
import { errorText } from "../lib/user-error";
import { createSpeechOwner, speakText, stopSpeaking } from "../lib/voice";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { SettingsGroup } from "./settings-group";

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
  const defaults = useScreenQuery(rpcQuery("voice/status"));
  const statusRead = rpcQuery("voice/status", { botId });
  const status = useScreenQuery(statusRead);
  const bot = botQuery.data;
  const provider = bot?.voiceProvider ?? defaults.data?.provider ?? "";
  const voices = useScreenQuery(rpcQuery("voice/voices", { provider }), {
    enabled: Boolean(provider),
  });
  const change = useSave({
    save: async (patch: { voiceProvider?: string | null; voiceId?: string | null }, send) => {
      const updated = await send("bots/update", { botId, ...patch });
      await writeSaved(queryClient, botRead.queryKey, () => updated);
    },
    stale: [statusRead.queryKey],
  });
  const sample = useSave({
    save: async () => {
      cancelled.current = false;
      const target = status.data;
      if (!target?.ready || !target.provider) throw new Error(t`Choose a voice in Settings first.`);
      const name = bot?.name.trim();
      const spoken = await speakText(
        name ? t`Hi, I'm ${ph({ name })}.` : t`Hi, this is how I'll sound.`,
        {
          botId,
          provider: target.provider,
          voiceId: target.voiceId || undefined,
          owner,
        },
      );
      if (!spoken && !cancelled.current) throw new Error(t`Could not play that sample.`);
    },
  });
  const busy = change.pending || sample.pending || !bot;
  const providerChoices = (catalog.data ?? [])
    .filter((entry) => credentials.data?.some((credential) => credential.provider === entry.id))
    .map((entry) => ({ key: entry.id, label: entry.name }));
  // A disconnected choice remains visible so it can be reset, rather than looking like Default.
  if (bot?.voiceProvider && !providerChoices.some((choice) => choice.key === bot.voiceProvider)) {
    providerChoices.push({
      key: bot.voiceProvider,
      label:
        catalog.data?.find((entry) => entry.id === bot.voiceProvider)?.name ?? bot.voiceProvider,
    });
  }
  const defaultProvider = catalog.data?.find((entry) => entry.id === defaults.data?.provider)?.name;
  const providerDefault = defaultProvider ? t`Default (${defaultProvider})` : t`Default`;
  const voiceChoices = (voices.data ?? []).map((voice) => ({ key: voice.id, label: voice.label }));
  if (bot?.voiceId && !voiceChoices.some((choice) => choice.key === bot.voiceId)) {
    voiceChoices.push({ key: bot.voiceId, label: bot.voiceId });
  }
  const defaultVoiceId = credentials.data?.find((entry) => entry.provider === provider)?.voiceId;
  const defaultVoice =
    voices.data?.find((voice) => voice.id === defaultVoiceId)?.label ?? defaultVoiceId;
  const voiceDefault = defaultVoice ? t`Default (${defaultVoice})` : t`Default`;
  const failure =
    change.error ??
    sample.error ??
    botQuery.error ??
    catalog.error ??
    credentials.error ??
    defaults.error ??
    status.error ??
    voices.error;

  return (
    <SettingsGroup label={t`Voice`} footer={failure ? errorText(failure) : undefined}>
      <MenuPicker
        label={t`Provider`}
        choices={[{ key: "", label: providerDefault }, ...providerChoices]}
        value={bot?.voiceProvider ?? ""}
        disabled={busy || !catalog.data || !credentials.data || !defaults.data}
        onChange={(key) => {
          if (key !== (bot?.voiceProvider ?? "")) {
            sample.reset();
            change.run({ voiceProvider: key || null, voiceId: null });
          }
        }}
      />
      {provider ? (
        <View style={styles.voiceRow}>
          <View style={styles.voicePicker}>
            <MenuPicker
              label={t`Voice`}
              choices={[{ key: "", label: voiceDefault }, ...voiceChoices]}
              value={bot?.voiceId ?? ""}
              disabled={busy || !voices.data}
              onChange={(key) => {
                if (key !== (bot?.voiceId ?? "")) {
                  sample.reset();
                  change.run({ voiceId: key || null });
                }
              }}
            />
          </View>
          <NativeActionButton
            accessibilityLabel={sample.pending ? t`Stop` : t`Hear a sample`}
            prominence="plain"
            icon={{
              ios: sample.pending ? "stop.fill" : "play.fill",
              android: sample.pending ? "stop" : "play",
            }}
            disabled={change.pending || !bot || !status.data?.ready}
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
