import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
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
import { rpc } from "../lib/api";
import { playMpeg, speakUtterance } from "../lib/voice";

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
};
type VoiceStatus = {
  configured: boolean;
  ready: boolean;
  provider: string | null;
  voiceId: string;
};
type VoiceInfo = { id: string; label: string; description?: string };

export default function VoiceSettings() {
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<VoiceCredential[]>([]);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    if (cred) {
      setVoices(await rpc<VoiceInfo[]>("voice/voices", { provider: selected }));
    } else {
      setVoices([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load()
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : "Could not load voice settings"),
        )
        .finally(() => setLoading(false));
    }, [load]),
  );

  const selected = catalog.find((entry) => entry.id === provider);
  const credential = credentials.find((entry) => entry.provider === provider);

  async function connect() {
    if (!selected || apiKey.trim().length < 8) return;
    setPending(true);
    setError(null);
    try {
      await rpc("voice/connect", {
        provider: selected.id,
        apiKey: apiKey.trim(),
        voiceId: voiceId || undefined,
      });
      setApiKey("");
      await load(selected.id);
      setNotice(`Connected ${selected.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect");
    } finally {
      setPending(false);
    }
  }

  async function chooseVoice(nextVoiceId: string) {
    setVoiceId(nextVoiceId);
    setPending(true);
    try {
      await rpc("voice/setVoice", { voiceId: nextVoiceId, provider: selected?.id });
      await load(selected?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that voice");
    } finally {
      setPending(false);
    }
  }

  async function testVoice() {
    setPending(true);
    setError(null);
    try {
      const prepared = await rpc<{ ready: boolean; utterances: string[] }>("voice/prepare", {
        text: "Hi, this is how I'll sound when I read replies out loud.",
      });
      if (!prepared.ready) throw new Error("Connect a voice provider first.");
      for (const utterance of prepared.utterances) {
        await playMpeg(await speakUtterance(utterance));
      }
      setNotice("If you heard that, voice is ready.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not play a sample");
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? <ActivityIndicator color="#ECECEE" /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <Text style={styles.lede}>
          Bring your own key. ElevenLabs, OpenAI, and Cartesia all plug into the same speak buttons.
        </Text>
        {catalog.map((entry) => {
          const connected = credentials.some((cred) => cred.provider === entry.id);
          return (
            <Pressable
              key={entry.id}
              onPress={() => {
                setProvider(entry.id);
                void load(entry.id);
              }}
              style={[styles.card, provider === entry.id && styles.cardActive]}
            >
              <Text style={styles.cardTitle}>{entry.name}</Text>
              <Text style={styles.cardMeta}>
                {connected ? "Connected" : entry.transcribe ? "Speak + transcribe" : "Speak only"}
              </Text>
            </Pressable>
          );
        })}
        {selected ? (
          <>
            <Text style={styles.help}>{selected.description}</Text>
            <TextInput
              accessibilityLabel="API key"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              importantForAutofill="no"
              value={apiKey}
              onChangeText={setApiKey}
              placeholder={credential ? "Paste a replacement key" : "Paste your API key"}
              placeholderTextColor="#6C6C70"
              secureTextEntry
              style={styles.input}
              textContentType="none"
            />
            <Pressable
              disabled={pending || apiKey.trim().length < 8}
              onPress={() => void connect()}
              style={[styles.button, (pending || apiKey.trim().length < 8) && styles.disabled]}
            >
              <Text style={styles.buttonLabel}>{credential ? "Replace key" : "Connect"}</Text>
            </Pressable>
            {voices.length ? (
              <View style={styles.voices}>
                {voices.map((voice) => (
                  <Pressable
                    key={voice.id}
                    onPress={() => void chooseVoice(voice.id)}
                    style={styles.voiceRow}
                  >
                    <Text style={styles.voiceLabel}>{voice.label}</Text>
                    {voiceId === voice.id ? <Text style={styles.check}>✓</Text> : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
            {status?.ready ? (
              <Pressable
                disabled={pending}
                onPress={() => void testVoice()}
                style={styles.secondary}
              >
                <Text style={styles.secondaryLabel}>Hear a sample</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  content: { padding: 20, gap: 10 },
  lede: { color: "#85858A", fontSize: 14, lineHeight: 20, marginBottom: 8 },
  error: { color: "#C94244", marginBottom: 8 },
  notice: { color: "#4ECB71", marginBottom: 8 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#26262A",
    padding: 14,
    backgroundColor: "#101012",
  },
  cardActive: { borderColor: "#4A4A50", backgroundColor: "#1A1A1D" },
  cardTitle: { color: "#ECECEE", fontSize: 16 },
  cardMeta: { color: "#6C6C70", marginTop: 4, fontSize: 12 },
  help: { color: "#85858A", fontSize: 13.5, lineHeight: 20, marginTop: 8 },
  input: {
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#26262A",
    color: "#ECECEE",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  button: {
    marginTop: 8,
    backgroundColor: "#F1F1EF",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  disabled: { opacity: 0.4 },
  buttonLabel: { color: "#17171A", fontWeight: "600" },
  voices: { marginTop: 12, borderRadius: 12, borderWidth: 1, borderColor: "#26262A" },
  voiceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#202023",
  },
  voiceLabel: { color: "#ECECEE" },
  check: { color: "#4ECB71" },
  secondary: { marginTop: 16, alignItems: "center" },
  secondaryLabel: { color: "#C9C9CE", fontSize: 15 },
});
