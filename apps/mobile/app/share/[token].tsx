import { parseShareManifestPayload, type ShareManifest } from "@rakazo/contracts";
import * as DocumentPicker from "expo-document-picker";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { loadSessionToken, type MobileBot, rpc } from "../../lib/api";

export default function ShareImportScreen() {
  const router = useRouter();
  const { token: routeToken } = useLocalSearchParams<{ token?: string }>();
  const [shareJson, setShareJson] = useState("");
  const [shareToken, setShareToken] = useState(routeToken ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    void loadSessionToken().then((session) => {
      const authed = Boolean(session);
      setSignedIn(authed);
      setAuthReady(true);
      if (!authed && routeToken) {
        router.replace(`/sign-in?next=${encodeURIComponent(`/share/${routeToken}`)}`);
      }
    });
  }, [routeToken, router]);

  async function importShare(input: { manifest?: ShareManifest; token?: string }) {
    setPending(true);
    setError(null);
    try {
      const bot = await rpc<MobileBot>(
        "bots/importShare",
        input.token ? { token: input.token } : { manifest: input.manifest! },
      );
      router.replace({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import share");
    } finally {
      setPending(false);
    }
  }

  async function importFromFields() {
    const token = shareToken.trim();
    if (token) {
      await importShare({ token });
      return;
    }
    const raw = shareJson.trim();
    if (!raw) {
      setError("Paste share JSON or a link token");
      return;
    }
    try {
      const manifest = parseShareManifestPayload(JSON.parse(raw) as unknown);
      await importShare({ manifest });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse share JSON");
    }
  }

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/json", "text/json", "public.json"],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    try {
      const text = await fetch(result.assets[0].uri).then((res) => res.text());
      const manifest = parseShareManifestPayload(JSON.parse(text) as unknown);
      await importShare({ manifest });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import share file");
    }
  }

  if (!authReady || !signedIn) {
    return (
      <View style={{ flex: 1, backgroundColor: "#050506", justifyContent: "center" }}>
        <Text style={{ color: "#6C6C70", textAlign: "center" }}>Loading…</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Import share" }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: "#050506" }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: "#6C6C70", fontSize: 13 }}>
          Configuration only — not a computer, logins, files, or chat history.
        </Text>
        <Text style={{ color: "#85858A", marginTop: 16, fontSize: 14 }}>Share JSON</Text>
        <TextInput
          value={shareJson}
          onChangeText={setShareJson}
          placeholder="Paste rakazo.share/v1 JSON"
          placeholderTextColor="#6C6C70"
          multiline
          style={{
            marginTop: 8,
            backgroundColor: "#1A1A1D",
            borderRadius: 11,
            padding: 16,
            color: "#ECECEE",
            minHeight: 120,
            textAlignVertical: "top",
          }}
        />
        <Text style={{ color: "#85858A", marginTop: 16, fontSize: 14 }}>Or link token</Text>
        <TextInput
          value={shareToken}
          onChangeText={setShareToken}
          placeholder="Token from a share URL"
          placeholderTextColor="#6C6C70"
          style={{
            marginTop: 8,
            backgroundColor: "#1A1A1D",
            borderRadius: 11,
            padding: 16,
            color: "#ECECEE",
          }}
        />
        <Pressable
          onPress={() => void pickFile()}
          disabled={pending}
          style={{
            marginTop: 16,
            borderRadius: 11,
            borderWidth: 1,
            borderColor: "#3A3A3F",
            padding: 16,
            alignItems: "center",
            opacity: pending ? 0.4 : 1,
          }}
        >
          <Text style={{ color: "#ECECEE", fontSize: 16 }}>Pick .json file</Text>
        </Pressable>
        {error ? <Text style={{ color: "#E65707", marginTop: 16 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void importFromFields()}
          disabled={pending}
          style={{
            marginTop: 24,
            backgroundColor: "#F1F1EF",
            borderRadius: 11,
            padding: 16,
            alignItems: "center",
            opacity: pending ? 0.4 : 1,
          }}
        >
          <Text style={{ color: "#17171A", fontSize: 16 }}>
            {pending ? "Importing…" : "Import"}
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
