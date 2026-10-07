import { useLocalSearchParams } from "expo-router";
import type { Voice } from "expo-speech";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { deviceVoices, setVoiceForBot, voiceForBot } from "../lib/bot-voices";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

/** "en-us-x-iol-local" reads as "en-US · iol": the engine's names are ids, not labels. */
function voiceLabel(voice: Voice): string {
  const code = voice.identifier.match(/-x-([a-z0-9]+)-/i)?.[1];
  const name = code ?? (voice.name !== voice.identifier ? voice.name : voice.identifier);
  return voice.language ? `${voice.language} · ${name}` : name;
}

export default function BotVoice() {
  const styles = useThemedStyles(createBotVoiceStyles);
  const { t } = useI18n();
  const { botId, name } = useLocalSearchParams<{ botId: string; name?: string }>();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!botId) return;
    void Promise.all([deviceVoices(), voiceForBot(botId)])
      .then(([available, current]) => {
        setVoices(available);
        setSelected(current);
      })
      .catch((err: unknown) => {
        setVoices([]);
        setError(err instanceof Error ? err.message : t("Could not load voices"));
      });
  }, [botId, t]);

  async function choose(voice: Voice) {
    if (!botId) return;
    setSelected(voice.identifier);
    try {
      await setVoiceForBot(botId, voice.identifier);
      const Speech = await import("expo-speech");
      Speech.stop();
      Speech.speak(name ? t("Hi, I'm {name}.", { name }) : t("Hi, this is how I'll sound."), {
        voice: voice.identifier,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save that voice"));
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {voices === null ? <ActivityIndicator color={native.secondaryLabel} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {voices?.length === 1 ? (
          <Text style={styles.hint}>{t("This speech engine has one voice.")}</Text>
        ) : null}
        {voices?.map((voice) => (
          <Pressable
            key={voice.identifier}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected === voice.identifier }}
            onPress={() => void choose(voice)}
            style={[styles.row, selected === voice.identifier && styles.rowActive]}
          >
            <Text style={styles.label}>{voiceLabel(voice)}</Text>
            {selected === voice.identifier ? <Text style={styles.check}>✓</Text> : null}
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function createBotVoiceStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 8 },
    error: { color: tokens.destructive, marginBottom: 8 },
    hint: { color: native.secondaryLabel, marginBottom: 8 },
    row: {
      minHeight: 48,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: tokens.border,
      paddingHorizontal: 14,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: tokens.card,
    },
    rowActive: { borderColor: tokens.ring, backgroundColor: tokens.muted },
    label: { color: native.label, fontSize: 15 },
    check: { color: native.label, fontSize: 16 },
  });
}
