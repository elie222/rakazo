import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  type ComputerMode,
  normalizeCreateBotProfile,
  type ShareManifest,
} from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Share, Text, TextInput } from "react-native";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { type MobileBot, rpc } from "../lib/api";

type BotSettingsRecord = MobileBot & {
  description?: string;
};

export default function BotSettingsScreen() {
  const router = useRouter();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const [bot, setBot] = useState<BotSettingsRecord | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareNotice, setShareNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!botId) return;
    void rpc<BotSettingsRecord>("bots/get", { botId })
      .then((next) => {
        setBot(next);
        setName(next.name);
        setTitle(next.title);
        setDescription(next.description ?? "");
        setComputerMode(next.computerMode);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load bot"));
  }, [botId]);

  async function save() {
    if (!botId || !bot || pending) return;
    setPending(true);
    setError(null);
    try {
      const profile = normalizeCreateBotProfile({ name, title, description });
      const input: {
        botId: string;
        name?: string;
        title?: string;
        description?: string;
        instructions?: string;
      } = { botId };
      if (profile.name !== bot.name) input.name = profile.name;
      if (profile.title !== bot.title) input.title = profile.title;
      if (profile.description !== (bot.description ?? "")) {
        input.description = profile.description;
        // Keep instructions in sync with description (same as web BotSettings).
        input.instructions = profile.instructions;
      }
      if (computerMode !== bot.computerMode) {
        await rpc("bots/setComputer", { botId, mode: computerMode });
      }
      // Use key presence so clearing title/description to "" still persists.
      if (Object.keys(input).length > 1) {
        await rpc("bots/update", input);
      }
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save bot");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: "Chat settings" }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: "#050506" }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={{ color: "#85858A", fontSize: 14 }}>Name</Text>
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
        <Text style={{ color: "#85858A", marginTop: 24, fontSize: 14 }}>Share bot</Text>
        <Text style={{ color: "#6C6C70", marginTop: 8, fontSize: 13 }}>
          Configuration only — not your computer, logins, files, or chat history.
        </Text>
        <Pressable
          onPress={() => {
            if (!botId || shareBusy) return;
            setShareBusy(true);
            void rpc<ShareManifest>("bots/shareManifest", { botId })
              .then(async (manifest) => {
                await Share.share({ message: JSON.stringify(manifest, null, 2) });
              })
              .catch((err) => setError(err instanceof Error ? err.message : "Could not share"))
              .finally(() => setShareBusy(false));
          }}
          disabled={shareBusy || !bot}
          style={{
            marginTop: 12,
            borderRadius: 11,
            borderWidth: 1,
            borderColor: "#3A3A3F",
            padding: 14,
            alignItems: "center",
            opacity: shareBusy || !bot ? 0.4 : 1,
          }}
        >
          <Text style={{ color: "#ECECEE" }}>Share JSON</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            if (!botId || shareBusy) return;
            setShareBusy(true);
            setShareNotice(null);
            void rpc<{ url: string; token: string }>("bots/shareCreate", { botId })
              .then(({ url, token }) => {
                setShareLink(url);
                setShareToken(token);
                setShareNotice("Share link created");
              })
              .catch((err) => setError(err instanceof Error ? err.message : "Could not create link"))
              .finally(() => setShareBusy(false));
          }}
          disabled={shareBusy || !bot}
          style={{
            marginTop: 8,
            borderRadius: 11,
            borderWidth: 1,
            borderColor: "#3A3A3F",
            padding: 14,
            alignItems: "center",
            opacity: shareBusy || !bot ? 0.4 : 1,
          }}
        >
          <Text style={{ color: "#ECECEE" }}>Create share link</Text>
        </Pressable>
        {shareLink ? (
          <Pressable
            onPress={() => void Share.share({ message: shareLink })}
            style={{ marginTop: 8 }}
          >
            <Text style={{ color: "#0A84FF", fontSize: 14 }}>{shareLink}</Text>
          </Pressable>
        ) : null}
        {shareToken ? (
          <Pressable
            onPress={() => {
              if (!shareToken || shareBusy) return;
              setShareBusy(true);
              void rpc("bots/shareRevoke", { token: shareToken })
                .then(() => {
                  setShareLink(null);
                  setShareToken(null);
                  setShareNotice("Share link revoked");
                })
                .catch((err) =>
                  setError(err instanceof Error ? err.message : "Could not revoke link"),
                )
                .finally(() => setShareBusy(false));
            }}
            style={{ marginTop: 8 }}
          >
            <Text style={{ color: "#E65707", fontSize: 14 }}>Revoke link</Text>
          </Pressable>
        ) : null}
        {shareNotice ? <Text style={{ color: "#6C6C70", marginTop: 8, fontSize: 13 }}>{shareNotice}</Text> : null}
        {error ? <Text style={{ color: "#E65707", marginTop: 16 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void save()}
          disabled={!name.trim() || pending || !bot}
          style={{
            marginTop: 24,
            backgroundColor: "#F1F1EF",
            borderRadius: 11,
            padding: 16,
            alignItems: "center",
            opacity: !name.trim() || pending || !bot ? 0.4 : 1,
          }}
        >
          <Text style={{ color: "#17171A", fontSize: 16 }}>{pending ? "Saving…" : "Save"}</Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
