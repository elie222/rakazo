import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { Checkmark } from "../../components/row-accessories";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } from "../../lib/device-voice";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { errorText } from "../../lib/user-error";
import { speakText } from "../../lib/voice";

type VoiceCatalogEntry = {
  id: string;
  name: string;
  description: string;
  transcribe: boolean;
};
type VoiceCredential = {
  id: string;
  provider: string;
  voiceId: string;
  speechModel?: string;
};
type VoiceStatus = {
  configured: boolean;
  ready: boolean;
  provider: string | null;
  voiceId: string;
};
type VoiceInfo = { id: string; label: string; description?: string };

export default function VoiceSettings() {
  const styles = useThemedStyles(createVoiceStyles);
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<VoiceCredential[]>([]);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [speechModel, setSpeechModel] = useState("");
  const speechModelSave = useRef<string | null>(null);
  const [deviceVoice, setDeviceVoice] = useState(false);
  const [deviceVoiceReady, setDeviceVoiceReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<
    "connect" | "disconnect" | "voice" | "speech" | "test" | "device-voice" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const deviceVoiceRevision = useRef(0);
  const deviceVoiceSaveInFlight = useRef(false);

  const load = useCallback(async (nextProvider?: string) => {
    const [nextCatalog, nextCredentials, nextStatus] = await Promise.all([
      rpc<VoiceCatalogEntry[]>("voice/catalog"),
      rpc<VoiceCredential[]>("voice/credentials"),
      rpc<VoiceStatus>("voice/status"),
    ]);
    const selected = nextProvider || nextStatus.provider || nextCatalog[0]?.id || "";
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setStatus(nextStatus);
    setProvider(selected);
    const cred = nextCredentials.find((entry) => entry.provider === selected);
    setVoiceId(cred?.voiceId ?? "");
    setSpeechModel(cred?.speechModel ?? "");
    if (cred) {
      setVoices(await rpc<VoiceInfo[]>("voice/voices", { provider: selected }));
    } else {
      setVoices([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      const revision = ++deviceVoiceRevision.current;
      void loadDeviceVoiceEnabled()
        .then((value) => {
          if (deviceVoiceSaveInFlight.current) return;
          if (deviceVoiceRevision.current !== revision) return;
          setDeviceVoice(value);
          setDeviceVoiceReady(true);
        })
        .catch((err: unknown) => {
          if (deviceVoiceSaveInFlight.current) return;
          if (deviceVoiceRevision.current !== revision) return;
          setDeviceVoiceReady(true);
          setError(errorText(err, t("Could not load voice settings")));
        });
      void load()
        .catch((err: unknown) => setError(errorText(err, t("Could not load voice settings"))))
        .finally(() => setLoading(false));
    }, [load, t]),
  );

  async function saveDeviceVoice(next: boolean): Promise<boolean> {
    deviceVoiceSaveInFlight.current = true;
    deviceVoiceRevision.current++;
    setDeviceVoice(next);
    try {
      await saveDeviceVoiceEnabled(next);
      return true;
    } catch (err) {
      setDeviceVoice(!next);
      setError(errorText(err, t("Could not save that preference")));
      return false;
    } finally {
      deviceVoiceSaveInFlight.current = false;
      deviceVoiceRevision.current++;
    }
  }

  async function toggleDeviceVoice() {
    if (pending !== null || !deviceVoiceReady) return;
    setPending("device-voice");
    setError(null);
    try {
      await saveDeviceVoice(!deviceVoice);
    } finally {
      setPending(null);
    }
  }

  async function chooseProvider(nextProvider: string) {
    if (pending !== null || !deviceVoiceReady) return;
    const wasDeviceVoice = deviceVoice;
    const previousProvider = provider;
    setPending("voice");
    setError(null);
    try {
      if (wasDeviceVoice && !(await saveDeviceVoice(false))) return;
      setProvider(nextProvider);
      const cred = credentials.find((entry) => entry.provider === nextProvider);
      if (cred?.voiceId && status?.provider !== nextProvider) {
        try {
          const saved = await rpc<VoiceStatus>("voice/setVoice", {
            voiceId: cred.voiceId,
            provider: nextProvider,
          });
          setStatus(saved);
        } catch (err) {
          setProvider(previousProvider);
          if (wasDeviceVoice && !(await saveDeviceVoice(true))) return;
          setError(errorText(err, t("Could not save that voice")));
          return;
        }
      }
      setApiKey("");
      setVoiceId(cred?.voiceId ?? "");
      setSpeechModel(cred?.speechModel ?? "");
      setVoices([]);
      try {
        await load(nextProvider);
      } catch (err) {
        // A refresh failure must not leave another provider's voices available.
        setVoices([]);
        setError(errorText(err, t("Could not load voice settings")));
      }
    } finally {
      setPending(null);
    }
  }

  const selected = catalog.find((entry) => entry.id === provider);
  const credential = credentials.find((entry) => entry.provider === provider);

  async function connect() {
    if (!selected || apiKey.trim().length < 8) return;
    setPending("connect");
    setError(null);
    try {
      await rpc("voice/connect", {
        provider: selected.id,
        apiKey: apiKey.trim(),
        voiceId: voiceId || undefined,
        ...(selected.id === "fish-audio" ? { speechModel: speechModel.trim() } : {}),
      });
      setApiKey("");
      await load(selected.id);
    } catch (err) {
      setError(errorText(err, t("Could not connect")));
    } finally {
      setPending(null);
    }
  }

  async function disconnect() {
    if (!credential) return;
    setPending("disconnect");
    setError(null);
    try {
      await rpc("voice/disconnect", { provider: credential.provider });
      setApiKey("");
      await load(credential.provider);
    } catch (err) {
      setError(errorText(err, t("Could not disconnect")));
    } finally {
      setPending(null);
    }
  }

  async function saveSpeechModel() {
    if (!credential || selected?.id !== "fish-audio" || pending !== null) return;
    const next = speechModel.trim();
    if (next === (credential.speechModel ?? "")) return;
    if (speechModelSave.current === next) return;
    speechModelSave.current = next;
    setPending("speech");
    setError(null);
    try {
      const saved = await rpc<VoiceCredential>("voice/setSpeechModel", {
        provider: selected.id,
        speechModel: next,
      });
      setSpeechModel(saved.speechModel ?? "");
      setCredentials((current) =>
        current.map((entry) => (entry.id === saved.id ? { ...entry, ...saved } : entry)),
      );
    } catch (err) {
      setError(errorText(err, t("Could not save that speech model")));
    } finally {
      speechModelSave.current = null;
      setPending(null);
    }
  }

  async function chooseVoice(nextVoiceId: string) {
    setVoiceId(nextVoiceId);
    setPending("voice");
    try {
      await rpc("voice/setVoice", { voiceId: nextVoiceId, provider: selected?.id });
      await load(selected?.id);
    } catch (err) {
      setError(errorText(err, t("Could not save that voice")));
    } finally {
      setPending(null);
    }
  }

  async function testVoice() {
    setPending("test");
    setError(null);
    try {
      const ready = await speakText(t("Hi, this is how I'll sound when I read replies out loud."));
      if (!ready) {
        throw new Error(t("Connect a voice provider first."));
      }
    } catch (err) {
      setError(errorText(err, t("Could not play a sample")));
    } finally {
      setPending(null);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        {loading ? <ActivityIndicator color={native.secondaryLabel} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.group}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: deviceVoice }}
            disabled={pending !== null || !deviceVoiceReady}
            onPress={() => void toggleDeviceVoice()}
            style={({ pressed }) => [
              styles.groupRow,
              (pending !== null || !deviceVoiceReady) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.rowCopy}>
              <Text style={styles.cardTitle}>{t("This device")}</Text>
              <Text style={styles.cardMeta}>
                {deviceVoice
                  ? t("On · Free, works offline")
                  : t("Your phone's built-in voice. Free, no account needed")}
              </Text>
            </View>
            {deviceVoice ? <Checkmark /> : null}
          </Pressable>
        </View>
        {catalog.length ? (
          <View style={styles.group}>
            {catalog.map((entry, index) => {
              const connected = credentials.some((cred) => cred.provider === entry.id);
              return (
                <Pressable
                  key={entry.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !deviceVoice && provider === entry.id }}
                  disabled={pending !== null || !deviceVoiceReady}
                  onPress={() => void chooseProvider(entry.id)}
                  style={({ pressed }) => [
                    styles.groupRow,
                    index > 0 && styles.groupDivider,
                    (pending !== null || !deviceVoiceReady) && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.rowCopy}>
                    <Text style={styles.cardTitle}>{entry.name}</Text>
                    <Text style={styles.cardMeta}>
                      {connected
                        ? t("Connected")
                        : entry.transcribe
                          ? t("Speak + transcribe")
                          : t("Speak only")}
                    </Text>
                  </View>
                  {!deviceVoice && provider === entry.id ? <Checkmark /> : null}
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {selected && !deviceVoice ? (
          <>
            <TextInput
              accessibilityLabel={t("API key")}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              importantForAutofill="no"
              value={apiKey}
              onChangeText={setApiKey}
              placeholder={credential ? t("Paste a replacement key") : t("Paste your API key")}
              placeholderTextColor={native.tertiaryLabel}
              secureTextEntry
              style={styles.input}
              textContentType="none"
            />
            <NativeActionButton
              disabled={pending !== null || apiKey.trim().length < 8}
              label={credential ? t("Replace key") : t("Connect")}
              onPress={() => void connect()}
            />
            {credential ? (
              <NativeActionButton
                disabled={pending !== null}
                label={pending === "disconnect" ? t("Disconnecting…") : t("Disconnect")}
                onPress={() => void disconnect()}
                prominence="destructive"
              />
            ) : null}
            {credential && selected.id === "fish-audio" ? (
              <>
                <Text style={styles.fieldLabel}>{t("Speech model")}</Text>
                <TextInput
                  accessibilityLabel={t("Speech model")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={pending === null}
                  value={speechModel}
                  onChangeText={setSpeechModel}
                  onBlur={() => void saveSpeechModel()}
                  onSubmitEditing={() => void saveSpeechModel()}
                  placeholder={t("Optional")}
                  placeholderTextColor={native.tertiaryLabel}
                  style={styles.input}
                />
              </>
            ) : null}
            {voices.length ? (
              <View style={[styles.group, styles.voices]}>
                {voices.map((voice, index) => (
                  <Pressable
                    key={voice.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: voiceId === voice.id }}
                    disabled={pending !== null}
                    onPress={() => void chooseVoice(voice.id)}
                    style={({ pressed }) => [
                      styles.groupRow,
                      index > 0 && styles.groupDivider,
                      pending !== null && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.voiceLabel}>{voice.label}</Text>
                    {voiceId === voice.id ? <Checkmark /> : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
        ) : null}
        {deviceVoice || status?.ready ? (
          <NativeActionButton
            disabled={pending !== null}
            label={t("Hear a sample")}
            onPress={() => void testVoice()}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createVoiceStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 10 },
    error: { color: tokens.destructive, marginBottom: 8 },
    group: { borderRadius: 14, backgroundColor: native.fill, overflow: "hidden" },
    groupRow: {
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    groupDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.separator,
    },
    rowCopy: { flex: 1 },
    cardTitle: { color: native.label, fontSize: 16 },
    cardMeta: { color: native.tertiaryLabel, marginTop: 4, fontSize: 12 },
    fieldLabel: { color: native.label, marginTop: 16 },
    input: {
      marginTop: 8,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
    voices: { marginTop: 12 },
    voiceLabel: { flex: 1, color: native.label, fontSize: 16 },
  });
}
