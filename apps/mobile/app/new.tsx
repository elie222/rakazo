import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  type ComputerMode,
  normalizeCreateBotProfile,
} from "@rakazo/contracts";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput } from "react-native";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { type MobileBot, rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { tokens } from "../lib/theme";

export default function NewBot() {
  const { t } = useI18n();
  const router = useRouter();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
      setError(err instanceof Error ? err.message : t("Could not create bot"));
    } finally {
      setPending(false);
    }
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
              accessibilityLabel={t("Cancel")}
            >
              <Text style={{ color: "#0A84FF", fontSize: 17 }}>{t("Cancel")}</Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={{ color: "#85858A", fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChangeText={setName}
          placeholder={t("Name this bot")}
          placeholderTextColor="#6C6C70"
          style={{
            marginTop: 8,
            backgroundColor: "#1A1A1D",
            borderRadius: 11,
            padding: 16,
            color: "#ECECEE",
          }}
        />
        <Text style={{ color: "#85858A", marginTop: 16, fontSize: 14 }}>{t("Title")}</Text>
        <TextInput
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChangeText={setTitle}
          placeholder={t("Describe what this bot does")}
          placeholderTextColor="#6C6C70"
          style={{
            marginTop: 8,
            backgroundColor: "#1A1A1D",
            borderRadius: 11,
            padding: 16,
            color: "#ECECEE",
          }}
        />
        <Text style={{ color: "#85858A", marginTop: 16, fontSize: 14 }}>{t("Description")}</Text>
        <TextInput
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChangeText={setDescription}
          placeholder={t("What this bot is for")}
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
        {error ? <Text style={{ color: "#EF4444", marginTop: 16 }}>{error}</Text> : null}
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
          <Text style={{ color: "#17171A", fontSize: 16 }}>
            {pending ? t("Creating…") : t("Create")}
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
