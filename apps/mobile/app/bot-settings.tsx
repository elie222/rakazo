import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  type ComputerMode,
  normalizeCreateBotProfile,
  type ThinkingLevel,
} from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { ComputerModePicker } from "../components/computer-mode-picker";
import {
  type MobileBot,
  type MobileMe,
  type MobileModel,
  type MobileModelCredential,
  rpc,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

type BotSettingsRecord = MobileBot & {
  description?: string;
};

type ModelOption = {
  key: string;
  provider: string;
  modelId: string;
  label: string;
};

type PickerChoice = {
  key: string;
  label: string;
};

export default function BotSettingsScreen() {
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const router = useRouter();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const [bot, setBot] = useState<BotSettingsRecord | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [modelMetaReady, setModelMetaReady] = useState(false);
  const [modelMetaError, setModelMetaError] = useState<string | null>(null);
  const [picker, setPicker] = useState<"model" | "thinking" | null>(null);
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
        setComputerMode(next.computerMode);
        setModelKey(
          next.modelProvider && next.modelId
            ? modelOptionKey(next.modelProvider, next.modelId)
            : "",
        );
        setThinkingLevel(next.thinkingLevel ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("Could not load bot")));
  }, [botId]);

  useEffect(() => {
    void Promise.all([
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
    ])
      .then(([nextMe, nextCatalog, nextCredentials]) => {
        setMe(nextMe);
        setCatalog(nextCatalog);
        setCredentials(nextCredentials);
        setModelMetaError(null);
        // Only mark ready on success — a failed catalog load must not clear
        // an existing thinkingLevel override on save.
        setModelMetaReady(true);
      })
      .catch((err) => {
        setModelMetaReady(false);
        setModelMetaError(err instanceof Error ? err.message : t("Could not load model settings"));
      });
  }, [t]);

  const connectedOptions = useMemo(() => {
    const options: ModelOption[] = [];
    const seen = new Set<string>();
    for (const credential of credentials) {
      const providerModels = catalog.filter(
        (entry) => entry.provider === credential.provider && !entry.placeholder,
      );
      const credentialInCatalog = Boolean(
        credential.modelId && providerModels.some((entry) => entry.id === credential.modelId),
      );
      // Catalog providers expand to every model for that connection. Free-form
      // credentials (model id not in the catalog) stay a single connected pair.
      const nextOptions =
        credential.modelId && !credentialInCatalog
          ? [
              {
                key: modelOptionKey(credential.provider, credential.modelId),
                provider: credential.provider,
                modelId: credential.modelId,
                label: `${credential.label} · ${credential.modelId}`,
              },
            ]
          : providerModels.map((entry) => ({
              key: modelOptionKey(entry.provider, entry.id),
              provider: entry.provider,
              modelId: entry.id,
              label: `${entry.providerName ?? entry.provider} · ${entry.label}`,
            }));
      for (const option of nextOptions) {
        if (seen.has(option.key)) continue;
        seen.add(option.key);
        options.push(option);
      }
    }
    return options;
  }, [catalog, credentials]);

  const effectiveProvider = modelKey
    ? parseModelOptionKey(modelKey)?.provider
    : (me?.defaultProvider ?? null);
  const effectiveModelId = modelKey
    ? parseModelOptionKey(modelKey)?.modelId
    : (me?.defaultModel ?? null);
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) => entry.provider === effectiveProvider && entry.id === effectiveModelId,
        )
      : undefined;
  const effectiveCredential = credentials.find(
    (entry) => entry.provider === effectiveProvider && entry.modelId === effectiveModelId,
  );
  const thinkingOptions = (
    effectiveCredential?.thinkingLevels ??
    effectiveEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");

  const spaceDefaultLabel = me?.defaultModel
    ? `${t("Space default")} (${catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel})`
    : t("Space default");

  const modelChoices: PickerChoice[] = useMemo(() => {
    const choices: PickerChoice[] = [{ key: "", label: spaceDefaultLabel }];
    if (modelKey && !connectedOptions.some((option) => option.key === modelKey)) {
      choices.push({
        key: modelKey,
        label: parseModelOptionKey(modelKey)?.modelId ?? modelKey,
      });
    }
    for (const option of connectedOptions) {
      choices.push({ key: option.key, label: option.label });
    }
    return choices;
  }, [connectedOptions, modelKey, spaceDefaultLabel]);

  const thinkingChoices: PickerChoice[] = useMemo(
    () => [
      { key: "", label: t("Default (medium)") },
      ...thinkingOptions.map((level) => ({
        key: level,
        label: thinkingLevelLabel(level, t),
      })),
    ],
    [t, thinkingOptions],
  );

  const selectedModelLabel =
    modelChoices.find((choice) => choice.key === modelKey)?.label ?? spaceDefaultLabel;
  const selectedThinkingLabel =
    thinkingChoices.find((choice) => choice.key === thinkingLevel)?.label ?? t("Default (medium)");

  function selectModel(key: string) {
    setModelKey(key);
    setThinkingLevel("");
  }

  function openModelPicker() {
    showNativePicker({
      title: t("Model"),
      choices: modelChoices,
      colorScheme,
      cancelLabel: t("Cancel"),
      onSelect: selectModel,
      onOpenAndroid: () => setPicker("model"),
    });
  }

  function openThinkingPicker() {
    showNativePicker({
      title: t("Thinking"),
      choices: thinkingChoices,
      colorScheme,
      cancelLabel: t("Cancel"),
      onSelect: setThinkingLevel,
      onOpenAndroid: () => setPicker("thinking"),
    });
  }

  async function save() {
    if (!botId || !bot || pending) return;
    setPending(true);
    setError(null);
    try {
      const profile = normalizeCreateBotProfile({ name, title, description });
      const selected = modelKey ? parseModelOptionKey(modelKey) : null;
      const input: {
        botId: string;
        name?: string;
        title?: string;
        description?: string;
        instructions?: string;
        modelProvider?: string | null;
        modelId?: string | null;
        thinkingLevel?: ThinkingLevel | null;
      } = { botId };
      if (profile.name !== bot.name) input.name = profile.name;
      if (profile.title !== bot.title) input.title = profile.title;
      if (profile.description !== (bot.description ?? "")) {
        input.description = profile.description;
        // Keep instructions in sync with description (same as web BotSettings).
        input.instructions = profile.instructions;
      }
      // Always persist the model pair so Space default clears an override even
      // when catalog metadata failed to load.
      input.modelProvider = selected?.provider ?? null;
      input.modelId = selected?.modelId ?? null;
      const modelChanged =
        (selected?.provider ?? null) !== (bot.modelProvider ?? null) ||
        (selected?.modelId ?? null) !== (bot.modelId ?? null);
      if (modelChanged) {
        // selectModel clears thinking locally; persist that clear even when
        // metadata failed, otherwise the previous override sticks on the server.
        input.thinkingLevel = thinkingOptions.length
          ? ((thinkingLevel || null) as ThinkingLevel | null)
          : null;
      } else if (modelMetaReady && thinkingOptions.length) {
        input.thinkingLevel = (thinkingLevel || null) as ThinkingLevel | null;
      }
      // If the model is unchanged and has no thinking options (disconnected or
      // metadata unavailable), omit thinkingLevel so an existing override stays.
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

  const androidChoices =
    picker === "model" ? modelChoices : picker === "thinking" ? thinkingChoices : [];

  return (
    <>
      <Stack.Screen options={{ title: t("Chat settings") }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
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
        <Text
          style={{ color: tokens.mutedForeground, marginTop: 16, marginBottom: 8, fontSize: 14 }}
        >
          {t("Model")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Model")}
          onPress={openModelPicker}
          style={{
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            paddingVertical: 12,
            paddingHorizontal: 16,
          }}
        >
          <Text style={{ color: tokens.foreground }}>{selectedModelLabel}</Text>
        </Pressable>
        {thinkingOptions.length ? (
          <>
            <Text
              style={{
                color: tokens.mutedForeground,
                marginTop: 16,
                marginBottom: 8,
                fontSize: 14,
              }}
            >
              {t("Thinking")}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Thinking")}
              onPress={openThinkingPicker}
              style={{
                borderWidth: 1,
                borderColor: tokens.border,
                backgroundColor: tokens.muted,
                borderRadius: 11,
                paddingVertical: 12,
                paddingHorizontal: 16,
              }}
            >
              <Text style={{ color: tokens.foreground }}>{selectedThinkingLabel}</Text>
            </Pressable>
          </>
        ) : null}
        {modelMetaError ? (
          <Text style={{ color: tokens.mutedForeground, marginTop: 12, fontSize: 13 }}>
            {modelMetaError}
          </Text>
        ) : null}
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
      <Modal
        visible={picker !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPicker(null)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            padding: 24,
            backgroundColor: tokens.overlay,
          }}
        >
          <Pressable
            accessibilityLabel={t("Cancel")}
            onPress={() => setPicker(null)}
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
          />
          <View
            accessibilityViewIsModal
            style={{
              maxHeight: "80%",
              backgroundColor: tokens.popover,
              borderRadius: 24,
              paddingVertical: 12,
            }}
          >
            <Text
              style={{
                color: tokens.mutedForeground,
                fontSize: 13,
                paddingHorizontal: 24,
                paddingBottom: 8,
              }}
            >
              {picker === "thinking" ? t("Thinking") : t("Model")}
            </Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              {androidChoices.map((choice) => (
                <Pressable
                  key={choice.key || "space-default"}
                  accessibilityRole="button"
                  onPress={() => {
                    if (picker === "model") selectModel(choice.key);
                    else setThinkingLevel(choice.key);
                    setPicker(null);
                  }}
                  style={{ minHeight: 56, justifyContent: "center", paddingHorizontal: 24 }}
                >
                  <Text
                    style={{
                      color:
                        (picker === "model" ? modelKey : thinkingLevel) === choice.key
                          ? tokens.popoverForeground
                          : tokens.mutedForeground,
                      fontSize: 16,
                    }}
                  >
                    {choice.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

function showNativePicker(input: {
  title: string;
  choices: PickerChoice[];
  colorScheme: "light" | "dark";
  cancelLabel: string;
  onSelect: (key: string) => void;
  onOpenAndroid: () => void;
}) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: input.title,
        options: [...input.choices.map((choice) => choice.label), input.cancelLabel],
        cancelButtonIndex: input.choices.length,
        userInterfaceStyle: input.colorScheme,
      },
      (index) => {
        const choice = input.choices[index];
        if (choice) input.onSelect(choice.key);
      },
    );
    return;
  }
  input.onOpenAndroid();
}

function modelOptionKey(provider: string, modelId: string) {
  return `${provider}::${modelId}`;
}

function parseModelOptionKey(key: string) {
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  return { provider: key.slice(0, separator), modelId: key.slice(separator + 2) };
}

function catalogLabel(
  catalog: MobileModel[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}

function thinkingLevelLabel(level: ThinkingLevel, t: (message: string) => string) {
  if (level === "xhigh") return t("Extra high");
  if (level === "low") return t("Low");
  if (level === "medium") return t("Medium");
  if (level === "high") return t("High");
  if (level === "minimal") return t("Minimal");
  if (level === "max") return t("Max");
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}
