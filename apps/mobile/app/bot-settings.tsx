import {
  BOT_COLORS,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  type ComputerMode,
  normalizeCreateBotProfile,
} from "@rakazo/contracts";
import {
  connectedModelOptions,
  modelCatalogLabel,
  modelOptionKey,
  parseModelOptionKey,
} from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { ComputerModePicker } from "../components/computer-mode-picker";
import {
  type MobileBot,
  type MobileMe,
  type MobileModel,
  type MobileModelCredential,
  rpc,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

type BotSettingsRecord = MobileBot & {
  description?: string;
};

export default function BotSettingsScreen() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const [bot, setBot] = useState<BotSettingsRecord | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(BOT_COLORS[0]);
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [modelKey, setModelKey] = useState("");
  const [models, setModels] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!botId) return;
    void rpc<BotSettingsRecord>("bots/get", { botId })
      .then((next) => {
        setBot(next);
        setName(next.name);
        setTitle(next.title);
        setDescription(next.description ?? "");
        setColor(next.color);
        setComputerMode(next.computerMode);
        setModelKey(
          next.modelProvider && next.modelId
            ? modelOptionKey(next.modelProvider, next.modelId)
            : "",
        );
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("Could not load bot")));
  }, [botId]);

  useEffect(() => {
    void Promise.all([
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
    ])
      .then(([nextMe, nextModels, nextCredentials]) => {
        setMe(nextMe);
        setModels(nextModels);
        setCredentials(nextCredentials);
      })
      .catch(() => setModelError(t("Could not load model choices")));
  }, []);

  const connectedOptions = connectedModelOptions(credentials, models);
  const defaultModelLabel = me?.defaultModel
    ? `${t("Space default")} (${modelCatalogLabel(models, me.defaultProvider, me.defaultModel) ?? me.defaultModel})`
    : t("Space default");
  const storedOption =
    modelKey && !connectedOptions.some((option) => option.key === modelKey)
      ? { key: modelKey, label: parseModelOptionKey(modelKey)?.modelId ?? modelKey }
      : null;
  const modelOptions = [
    { key: "", label: defaultModelLabel },
    ...(storedOption ? [storedOption] : []),
    ...connectedOptions.map((option) => ({ key: option.key, label: option.label })),
  ];
  const selectedModelLabel =
    modelOptions.find((option) => option.key === modelKey)?.label ?? defaultModelLabel;

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
        color?: string;
        modelProvider?: string | null;
        modelId?: string | null;
      } = { botId };
      if (profile.name !== bot.name) input.name = profile.name;
      if (profile.title !== bot.title) input.title = profile.title;
      if (profile.description !== (bot.description ?? "")) {
        input.description = profile.description;
        // Keep instructions in sync with description (same as web BotSettings).
        input.instructions = profile.instructions;
      }
      if (color !== bot.color) input.color = color;
      const selectedModel = modelKey ? parseModelOptionKey(modelKey) : null;
      const nextModelProvider = selectedModel?.provider ?? null;
      const nextModelId = selectedModel?.modelId ?? null;
      if (nextModelProvider !== bot.modelProvider || nextModelId !== bot.modelId) {
        input.modelProvider = nextModelProvider;
        input.modelId = nextModelId;
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
      setError(err instanceof Error ? err.message : t("Could not save bot"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: t("Chat settings") }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {bot ? (
          <View style={{ alignItems: "center", marginBottom: 24 }}>
            <BotAvatar color={color} identity={bot.id} size={64} status={bot.status} />
          </View>
        ) : null}
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChangeText={setName}
          placeholder={t("Name this bot")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Title")}
        </Text>
        <TextInput
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChangeText={setTitle}
          placeholder={t("Describe what this bot does")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Description")}
        </Text>
        <TextInput
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChangeText={setDescription}
          placeholder={t("What this bot is for")}
          placeholderTextColor={tokens.mutedForeground}
          multiline
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
            minHeight: 120,
            textAlignVertical: "top",
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Model")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Model")}
          accessibilityState={{ expanded: modelPickerOpen }}
          onPress={() => setModelPickerOpen((open) => !open)}
          style={{
            marginTop: 8,
            minHeight: 52,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            paddingHorizontal: 16,
            paddingVertical: 12,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 15, flex: 1 }}>
            {selectedModelLabel}
          </Text>
          <Text style={{ color: tokens.mutedForeground, fontSize: 18 }}>
            {modelPickerOpen ? "⌃" : "⌄"}
          </Text>
        </Pressable>
        {modelPickerOpen ? (
          <View
            accessibilityRole="radiogroup"
            style={{
              marginTop: 8,
              borderRadius: 11,
              overflow: "hidden",
              backgroundColor: tokens.muted,
            }}
          >
            {modelOptions.map((option, index) => (
              <Pressable
                key={option.key || "space-default"}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ checked: option.key === modelKey }}
                onPress={() => {
                  setModelKey(option.key);
                  setModelPickerOpen(false);
                }}
                style={{
                  minHeight: 52,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  borderBottomWidth: index === modelOptions.length - 1 ? 0 : 1,
                  borderBottomColor: tokens.background,
                }}
              >
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: tokens.mutedForeground,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {option.key === modelKey ? (
                    <View
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 5,
                        backgroundColor: tokens.foreground,
                      }}
                    />
                  ) : null}
                </View>
                <Text style={{ color: tokens.foreground, fontSize: 15, flex: 1 }}>
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {modelError ? (
          <Text style={{ color: tokens.destructive, marginTop: 8 }}>{modelError}</Text>
        ) : null}
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Color")}
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 10, marginTop: 8 }}
          accessibilityRole="radiogroup"
        >
          {BOT_COLORS.map((option, index) => (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityLabel={t("Color {number}", { number: index + 1 })}
              accessibilityState={{ checked: color === option }}
              onPress={() => setColor(option)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: option,
                borderWidth: 3,
                borderColor: color === option ? tokens.foreground : "transparent",
              }}
            />
          ))}
        </ScrollView>
        <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void save()}
          disabled={!name.trim() || pending || !bot}
          style={{
            marginTop: 24,
            backgroundColor: tokens.primary,
            borderRadius: 11,
            padding: 16,
            alignItems: "center",
            opacity: !name.trim() || pending || !bot ? 0.4 : 1,
          }}
        >
          <Text style={{ color: tokens.primaryForeground, fontSize: 16 }}>
            {pending ? t("Saving…") : t("Save")}
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
