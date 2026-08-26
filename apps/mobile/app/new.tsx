import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  type ComputerMode,
  normalizeCreateBotProfile,
  parseShareManifestPayload,
  type ShareManifest,
} from "@rakazo/contracts";
import * as DocumentPicker from "expo-document-picker";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput } from "react-native";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { type MobileBot, rpc } from "../lib/api";

export default function NewBot() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [shareJson, setShareJson] = useState("");
  const [shareToken, setShareToken] = useState("");
  const [importingShare, setImportingShare] = useState(false);

  function close() {
    if (router.canDismiss()) {
      router.dismiss();
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/");
  }

  async function create() {
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const bot = await rpc<MobileBot>("bots/create", {
        ...normalizeCreateBotProfile({ name, title, description }),
        notifyOnFinish: true,
        computerMode,
      });
      router.replace({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create bot");
    } finally {
      setPending(false);
    }
  }

  async function importShare(input: { manifest?: ShareManifest; token?: string }) {
    setImportingShare(true);
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
      setImportingShare(false);
    }
  }

  async function importFromShareFields() {
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
    const manifest = parseShareManifestPayload(JSON.parse(raw) as unknown);
    await importShare({ manifest });
  }

  async function pickShareFile() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/json", "text/json", "public.json"],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const text = await fetch(result.assets[0].uri).then((res) => res.text());
    const manifest = parseShareManifestPayload(JSON.parse(text) as unknown);
    await importShare({ manifest });
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable
              onPress={close}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={{ color: "#0A84FF", fontSize: 17 }}>Cancel</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: "#050506" }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={{ color: "#6C6C70", fontSize: 13 }}>
          Import from share — configuration only, not computer or logins.
        </Text>
        <TextInput
          value={shareJson}
          onChangeText={setShareJson}
          placeholder="Paste share JSON"
          placeholderTextColor="#6C6C70"
          multiline
          style={{
            marginTop: 12,
            backgroundColor: "#1A1A1D",
            borderRadius: 11,
            padding: 16,
            color: "#ECECEE",
            minHeight: 80,
            textAlignVertical: "top",
          }}
        />
        <TextInput
          value={shareToken}
          onChangeText={setShareToken}
          placeholder="Or paste link token"
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
          onPress={() => void pickShareFile()}
          disabled={importingShare}
          style={{
            marginTop: 8,
            borderRadius: 11,
            borderWidth: 1,
            borderColor: "#3A3A3F",
            padding: 14,
            alignItems: "center",
            opacity: importingShare ? 0.4 : 1,
          }}
        >
          <Text style={{ color: "#ECECEE" }}>Pick .json file</Text>
        </Pressable>
        <Pressable
          onPress={() => void importFromShareFields()}
          disabled={importingShare}
          style={{
            marginTop: 8,
            borderRadius: 11,
            borderWidth: 1,
            borderColor: "#3A3A3F",
            padding: 14,
            alignItems: "center",
            opacity: importingShare ? 0.4 : 1,
          }}
        >
          <Text style={{ color: "#ECECEE" }}>{importingShare ? "Importing…" : "Import share"}</Text>
        </Pressable>
        <Text style={{ color: "#85858A", marginTop: 24, fontSize: 14 }}>Name</Text>
        <TextInput
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChangeText={setName}
          placeholder="Name this bot"
          placeholderTextColor="#6C6C70"
          style={{
            marginTop: 8,
            backgroundColor: "#1A1A1D",
            borderRadius: 11,
            padding: 16,
            color: "#ECECEE",
          }}
        />
        <Text style={{ color: "#85858A", marginTop: 16, fontSize: 14 }}>Title</Text>
        <TextInput
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChangeText={setTitle}
          placeholder="Describe what this bot does"
          placeholderTextColor="#6C6C70"
          style={{
            marginTop: 8,
            backgroundColor: "#1A1A1D",
            borderRadius: 11,
            padding: 16,
            color: "#ECECEE",
          }}
        />
        <Text style={{ color: "#85858A", marginTop: 16, fontSize: 14 }}>Description</Text>
        <TextInput
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChangeText={setDescription}
          placeholder="What this bot is for"
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
        <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        {error ? <Text style={{ color: "#E65707", marginTop: 16 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void create()}
          disabled={!name.trim() || pending}
          style={{
            marginTop: 24,
            backgroundColor: "#F1F1EF",
            borderRadius: 11,
            padding: 16,
            alignItems: "center",
            opacity: !name.trim() || pending ? 0.4 : 1,
          }}
        >
          <Text style={{ color: "#17171A", fontSize: 16 }}>{pending ? "Creating…" : "Create"}</Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
