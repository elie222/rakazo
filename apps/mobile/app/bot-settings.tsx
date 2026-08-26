import type { ComputerStatus } from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  type ComputerMode,
  normalizeCreateBotProfile,
} from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput } from "react-native";
import { ComputerMaintenanceActions } from "../components/computer-maintenance-actions";
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
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!botId) return;
    void Promise.all([
      rpc<BotSettingsRecord>("bots/get", { botId }),
      rpc<ComputerStatus>("computer/status", { botId }).catch(() => null),
    ])
      .then(([next, status]) => {
        setBot(next);
        setName(next.name);
        setTitle(next.title);
        setDescription(next.description ?? "");
        setComputerMode(next.computerMode);
        setComputer(status);
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
        <ComputerMaintenanceActions
          botId={botId}
          computer={computer}
          onChanged={async () => {
            const status = await rpc<ComputerStatus>("computer/status", { botId });
            setComputer(status);
          }}
        />
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
