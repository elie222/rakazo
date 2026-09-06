import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  type ComputerMode,
  type ThinkingLevel,
  normalizeCreateBotProfile,
} from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
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

type ModelOption = {
  key: string;
  provider: string;
  modelId: string;
  label: string;
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
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [modelMetaReady, setModelMetaReady] = useState(false);
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
        // Only mark ready on success — a failed catalog load must not clear
        // an existing thinkingLevel override on save.
        setModelMetaReady(true);
      })
      .catch(() => undefined);
  }, []);

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
      if (modelMetaReady) {
        input.modelProvider = selected?.provider ?? null;
        input.modelId = selected?.modelId ?? null;
        input.thinkingLevel = thinkingOptions.length
          ? ((thinkingLevel || null) as ThinkingLevel | null)
          : null;
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
        <View style={{ gap: 8 }}>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: modelKey === "" }}
            onPress={() => {
              setModelKey("");
              setThinkingLevel("");
            }}
            style={{
              borderWidth: 1,
              borderColor: modelKey === "" ? tokens.mutedForeground : tokens.border,
              backgroundColor: modelKey === "" ? tokens.muted : "transparent",
              borderRadius: 11,
              paddingVertical: 12,
              paddingHorizontal: 16,
            }}
          >
            <Text style={{ color: modelKey === "" ? tokens.foreground : tokens.mutedForeground }}>
              {spaceDefaultLabel}
            </Text>
          </Pressable>
          {modelKey && !connectedOptions.some((option) => option.key === modelKey) ? (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: true }}
              onPress={() => undefined}
              style={{
                borderWidth: 1,
                borderColor: tokens.mutedForeground,
                backgroundColor: tokens.muted,
                borderRadius: 11,
                paddingVertical: 12,
                paddingHorizontal: 16,
              }}
            >
              <Text style={{ color: tokens.foreground }}>
                {parseModelOptionKey(modelKey)?.modelId ?? modelKey}
              </Text>
            </Pressable>
          ) : null}
          {connectedOptions.map((option) => {
            const selected = option.key === modelKey;
            return (
              <Pressable
                key={option.key}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => {
                  setModelKey(option.key);
                  setThinkingLevel("");
                }}
                style={{
                  borderWidth: 1,
                  borderColor: selected ? tokens.mutedForeground : tokens.border,
                  backgroundColor: selected ? tokens.muted : "transparent",
                  borderRadius: 11,
                  paddingVertical: 12,
                  paddingHorizontal: 16,
                }}
              >
                <Text style={{ color: selected ? tokens.foreground : tokens.mutedForeground }}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
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
            <View style={{ gap: 8 }}>
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: thinkingLevel === "" }}
                onPress={() => setThinkingLevel("")}
                style={{
                  borderWidth: 1,
                  borderColor: thinkingLevel === "" ? tokens.mutedForeground : tokens.border,
                  backgroundColor: thinkingLevel === "" ? tokens.muted : "transparent",
                  borderRadius: 11,
                  paddingVertical: 12,
                  paddingHorizontal: 16,
                }}
              >
                <Text
                  style={{
                    color: thinkingLevel === "" ? tokens.foreground : tokens.mutedForeground,
                  }}
                >
                  {t("Default (medium)")}
                </Text>
              </Pressable>
              {thinkingOptions.map((level) => {
                const selected = thinkingLevel === level;
                return (
                  <Pressable
                    key={level}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => setThinkingLevel(level)}
                    style={{
                      borderWidth: 1,
                      borderColor: selected ? tokens.mutedForeground : tokens.border,
                      backgroundColor: selected ? tokens.muted : "transparent",
                      borderRadius: 11,
                      paddingVertical: 12,
                      paddingHorizontal: 16,
                    }}
                  >
                    <Text style={{ color: selected ? tokens.foreground : tokens.mutedForeground }}>
                      {thinkingLevelLabel(level, t)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </>
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
    </>
  );
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
