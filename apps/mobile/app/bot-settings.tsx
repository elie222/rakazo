import type { Bot, BotAvatarSet, ComputerMode, ThinkingLevel } from "@rakazo/contracts";
import {
  BOT_AVATAR_SHAPE_COUNT,
  BOT_COLORS,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  resolveBotAvatarSet,
} from "@rakazo/contracts";
import {
  credentialForModel,
  MODEL_SEARCH_THRESHOLD,
  modelOptionKey,
  parseModelOptionKey,
  resolveSelectableModelId,
} from "@rakazo/core";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { Voice } from "expo-speech";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColorValue } from "react-native";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { BotContextCards } from "../components/bot-context-cards";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { glassHeaderOptions } from "../components/glass-title";
import type { MenuPickerChoice } from "../components/menu-picker";
import { MenuPicker, MenuPickerMenu } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSwitch } from "../components/native-switch";
import { NativeSymbol } from "../components/native-symbol";
import { ProfileEditDialog } from "../components/profile-edit-dialog";
import { Chevron } from "../components/row-accessories";
import type { MobileMe, MobileModel, MobileModelCredential } from "../lib/api";
import { rpc } from "../lib/api";
import {
  avatarColor,
  avatarShape,
  isAvatarPhoto,
  withAvatarColor,
  withAvatarShape,
} from "../lib/bot-avatar-edit";
import { deviceVoices, setVoiceForBot, voiceForBot, voiceLabel } from "../lib/bot-voices";
import { chatModelPickerChoices } from "../lib/chat-model";
import { COMPUTER_LIFECYCLE_TIMEOUT_MS } from "../lib/computer";
import { loadDeviceVoiceEnabled } from "../lib/device-voice";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { createQueuedSave } from "../lib/queued-save";
import { useSideInsets } from "../lib/side-insets";
import { thinkingLevelLabel } from "../lib/thinking-level";
import { errorText } from "../lib/user-error";
import { stopVoicePlayback } from "../lib/voice";

export default function BotSettingsScreen() {
  const sideInsets = useSideInsets();
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const {
    botId,
    model: pickedModel,
    focus,
  } = useLocalSearchParams<{ botId: string; model?: string; focus?: string }>();
  const scrollRef = useRef<ScrollView>(null);
  const modelY = useRef(0);
  const [bot, setBot] = useState<Bot | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [color, setColor] = useState<string>(BOT_COLORS[0]);
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [avatarSet, setAvatarSet] = useState<BotAvatarSet>("organic");
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(focus === "model" || pickedModel !== undefined);
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [notifyOnFinish, setNotifyOnFinish] = useState(true);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [crossSpaceCommunication, setCrossSpaceCommunication] = useState(false);
  const [fleetManagement, setFleetManagement] = useState(false);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [modelMetaReady, setModelMetaReady] = useState(false);
  const [modelMetaError, setModelMetaError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceVoiceEnabled, setDeviceVoiceEnabled] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string | undefined>();
  const savedVoiceId = useRef<string | undefined>(undefined);
  const voiceChoice = useRef(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const crossSpaceSave = useMemo(
    () =>
      createQueuedSave<boolean>(false, {
        save: async (value) => {
          await rpc("bots/update", { botId, crossSpaceCommunication: value });
        },
        onChange: setCrossSpaceCommunication,
        onError: (err) => setError(errorText(err, t("Could not save bot"))),
      }),
    [botId, t],
  );

  const fleetSave = useMemo(
    () =>
      createQueuedSave<boolean>(false, {
        save: async (value) => {
          await rpc("bots/update", { botId, fleetManagement: value });
        },
        onChange: setFleetManagement,
        onError: (err) => setError(errorText(err, t("Could not save bot"))),
      }),
    [botId, t],
  );

  const notifySave = useMemo(
    () =>
      createQueuedSave<boolean>(true, {
        save: async (notifyOnFinish) => {
          await rpc("bots/update", { botId, notifyOnFinish });
        },
        onChange: setNotifyOnFinish,
        onError: (err) => setError(errorText(err)),
      }),
    [botId],
  );
  const nameSave = useMemo(
    () =>
      createQueuedSave<string>("", {
        save: async (name) => {
          await rpc("bots/update", { botId, name });
        },
        onChange: setName,
        onSaved: async (name) => {
          setBot((prev) => (prev ? { ...prev, name } : prev));
        },
        onError: (err) => setError(errorText(err)),
      }),
    [botId],
  );

  useEffect(() => {
    if (!botId) return;
    void rpc("bots/get", { botId })
      .then((next) => {
        setBot(next);
        setName(next.name);
        nameSave.reset(next.name);
        notifySave.reset(next.notifyOnFinish ?? true);
        setDescription(next.description ?? "");
        setInstructions(next.instructions ?? "");
        setColor(next.color);
        setAvatarSet(resolveBotAvatarSet(next.avatarSet));
        setComputerMode(next.computerMode);
        setModelKey(
          next.modelProvider && next.modelId
            ? modelOptionKey(next.modelProvider, next.modelId)
            : "",
        );
        setThinkingLevel(next.thinkingLevel ?? "");
        setAutoSpeak(next.autoSpeak);
        setNotifyOnFinish(next.notifyOnFinish ?? true);
        setCrossSpaceCommunication(next.crossSpaceCommunication ?? false);
        crossSpaceSave.reset(next.crossSpaceCommunication ?? false);
        setFleetManagement(next.fleetManagement);
        fleetSave.reset(next.fleetManagement);
      })
      .catch((err) => setError(errorText(err, t("Could not load bot"))));
  }, [botId, crossSpaceSave, fleetSave, notifySave, nameSave]);

  useEffect(() => {
    void Promise.all([rpc("me"), rpc("models/list"), rpc("models/credentials")])
      .then(([nextMe, nextCatalog, nextCredentials]) => {
        setMe(nextMe);
        setCatalog(nextCatalog);
        setCredentials(nextCredentials);
        setModelMetaError(null);
        setModelMetaReady(true);
      })
      .catch((err) => {
        setModelMetaReady(false);
        setModelMetaError(errorText(err, t("Could not load model settings")));
      });
  }, [t]);

  const storedModel = modelKey ? parseModelOptionKey(modelKey) : null;
  const selectedModel = storedModel
    ? {
        provider: storedModel.provider,
        modelId: resolveSelectableModelId(catalog, storedModel.provider, storedModel.modelId),
      }
    : null;
  const selectedModelKey = selectedModel
    ? modelOptionKey(selectedModel.provider, selectedModel.modelId)
    : "";

  const effectiveProvider = selectedModel?.provider ?? me?.defaultProvider ?? null;
  const effectiveModelId = selectedModel?.modelId ?? me?.defaultModel ?? null;
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) =>
            entry.provider === effectiveProvider &&
            resolveSelectableModelId(catalog, entry.provider, entry.id) === effectiveModelId,
        )
      : undefined;
  const effectiveCredential = credentialForModel(credentials, effectiveProvider, effectiveModelId);
  const thinkingOptions = (
    effectiveCredential?.thinkingLevels ??
    effectiveEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");

  const modelChoices = useMemo(
    () => chatModelPickerChoices(me, catalog, credentials, selectedModelKey, t),
    [catalog, credentials, me, selectedModelKey, t],
  );

  const thinkingChoices: MenuPickerChoice[] = useMemo(
    () => [
      { key: "", label: t("Default") },
      ...thinkingOptions.map((level) => ({
        key: level,
        label: thinkingLevelLabel(level, t),
      })),
    ],
    [t, thinkingOptions],
  );

  useEffect(() => {
    if (focus === "model") setAdvancedOpen(true);
  }, [focus]);

  function selectModel(key: string) {
    if (key === selectedModelKey) return;
    setModelKey(key);
    setThinkingLevel("");
  }

  // The searchable model list hands its pick back as a one-shot route param.
  useEffect(() => {
    if (pickedModel === undefined) return;
    router.setParams({ model: undefined });
    setAdvancedOpen(true);
    selectModel(pickedModel);
  }, [pickedModel]);

  function applyVoices(available: Voice[], assigned: string | undefined) {
    setVoices(available);
    savedVoiceId.current = assigned;
    setVoiceId(assigned);
    setVoiceError(null);
  }

  function failVoices() {
    setVoices([]);
    setVoiceError(t("Could not load voices"));
  }

  useFocusEffect(
    useCallback(() => {
      let current = true;
      void loadDeviceVoiceEnabled()
        .then((enabled) => {
          if (current) setDeviceVoiceEnabled(enabled);
        })
        .catch(() => {
          if (current) setDeviceVoiceEnabled(false);
        });
      return () => {
        current = false;
      };
    }, []),
  );

  useEffect(() => {
    if (!botId || !deviceVoiceEnabled) return;
    let current = true;
    void Promise.all([deviceVoices(), voiceForBot(botId)])
      .then(([available, assigned]) => {
        if (!current) return;
        applyVoices(available, assigned);
      })
      .catch(() => {
        if (!current) return;
        failVoices();
      });
    return () => {
      current = false;
    };
  }, [botId, deviceVoiceEnabled, t]);

  async function chooseVoice(voice: Voice) {
    if (!botId) return;
    // Picking a voice cuts off a reply in progress before the sample starts.
    stopVoicePlayback();
    const choice = ++voiceChoice.current;
    setVoiceId(voice.identifier);
    setError(null);
    try {
      await setVoiceForBot(botId, voice.identifier);
      savedVoiceId.current = voice.identifier;
    } catch {
      if (choice !== voiceChoice.current) return;
      setVoiceId(savedVoiceId.current);
      setError(t("Could not save that voice"));
      return;
    }
    if (choice !== voiceChoice.current) return;
    try {
      // Native speech loads only when a voice is previewed, as in lib/voice.
      const Speech = await import("expo-speech");
      if (choice !== voiceChoice.current) return;
      await Speech.stop();
      if (choice !== voiceChoice.current) return;
      const sampleName = name.trim();
      Speech.speak(
        sampleName ? t("Hi, I'm {name}.", { name: sampleName }) : t("Hi, this is how I'll sound."),
        { voice: voice.identifier },
      );
    } catch {
      // The choice is already saved. A sample that cannot play is not a failed save.
    }
  }

  const currentVoice = voices.find((voice) => voice.identifier === voiceId);
  const currentVoiceLabel = currentVoice ? voiceLabel(currentVoice) : t("Default");

  async function retryDeviceVoices() {
    if (!botId) return;
    try {
      const [available, assigned] = await Promise.all([deviceVoices(), voiceForBot(botId)]);
      applyVoices(available, assigned);
    } catch {
      failVoices();
    }
  }

  async function save() {
    if (!botId || !bot || pending) return;
    setPending(true);
    setError(null);
    try {
      const profile = { description: description.trim() };
      const selected = selectedModel;
      const input: {
        botId: string;
        description?: string;
        instructions?: string;
        expectedInstructions?: string;
        color?: string;
        avatarSet?: BotAvatarSet;
        modelProvider?: string | null;
        modelId?: string | null;
        thinkingLevel?: ThinkingLevel | null;
        autoSpeak?: boolean;
      } = { botId };
      if (profile.description !== (bot.description ?? "")) {
        input.description = profile.description;
      }
      if (instructions !== bot.instructions) {
        input.instructions = instructions;
        input.expectedInstructions = bot.instructions;
      }
      if (color !== bot.color) input.color = color;
      if (avatarSet !== resolveBotAvatarSet(bot.avatarSet)) input.avatarSet = avatarSet;
      const modelChanged =
        (selected?.provider ?? null) !== (bot.modelProvider ?? null) ||
        (selected?.modelId ?? null) !== (bot.modelId ?? null);
      const thinkingChanged = (thinkingLevel || null) !== (bot.thinkingLevel ?? null);
      if (modelChanged) {
        input.modelProvider = selected?.provider ?? null;
        input.modelId = selected?.modelId ?? null;
      }
      if (modelMetaReady && (modelChanged || thinkingChanged)) {
        input.thinkingLevel = thinkingOptions.length
          ? ((thinkingLevel || null) as ThinkingLevel | null)
          : null;
      }
      if (autoSpeak !== bot.autoSpeak) input.autoSpeak = autoSpeak;
      if (computerMode !== bot.computerMode) {
        await rpc(
          "bots/setComputer",
          { botId, mode: computerMode },
          { timeoutMs: COMPUTER_LIFECYCLE_TIMEOUT_MS },
        );
        setBot((prev) => (prev ? { ...prev, computerMode } : prev));
      }
      // Use key presence so clearing description to "" still persists.
      if (Object.keys(input).length > 1) {
        const updated = await rpc("bots/update", input);
        // Saved edits and their history become the baseline, so a retry after a failed switch write
        // does not resend them.
        const { botId: _botId, expectedInstructions: _expected, ...saved } = input;
        setBot((prev) => (prev ? { ...prev, ...saved, ...updated } : prev));
      }
      await Promise.all([
        crossSpaceSave.flush(),
        fleetSave.flush(),
        notifySave.flush(),
        nameSave.flush(),
      ]);
      router.back();
    } catch (err) {
      setError(errorText(err, t("Could not save bot")));
    } finally {
      setPending(false);
    }
  }

  const dirty =
    bot &&
    (description.trim() !== (bot.description ?? "") ||
      instructions !== (bot.instructions ?? "") ||
      color !== bot.color ||
      avatarSet !== resolveBotAvatarSet(bot.avatarSet) ||
      computerMode !== bot.computerMode ||
      autoSpeak !== bot.autoSpeak ||
      (selectedModel?.provider ?? null) !== (bot.modelProvider ?? null) ||
      (selectedModel?.modelId ?? null) !== (bot.modelId ?? null) ||
      (thinkingLevel || null) !== (bot.thinkingLevel ?? null));

  const voiceValue = (
    <Text
      numberOfLines={1}
      style={[styles.rowValue, { color: voiceError ? tokens.destructive : tokens.foreground }]}
    >
      {voiceError ?? currentVoiceLabel}
    </Text>
  );
  const hasVoiceMenu = !voiceError && voices.length > 1;
  const voiceRowContent = (
    <View
      accessibilityLabel={hasVoiceMenu ? t("Device voice") : undefined}
      accessibilityRole={hasVoiceMenu ? "button" : undefined}
      accessibilityValue={hasVoiceMenu ? { text: currentVoiceLabel } : undefined}
      accessible={hasVoiceMenu}
      style={styles.row}
    >
      <Text style={[styles.rowLabel, { color: tokens.foreground }]}>{t("Device voice")}</Text>
      {hasVoiceMenu ? (
        <View style={styles.voiceTrigger}>
          {voiceValue}
          <NativeSymbol
            android="chevron-expand"
            color={native.tertiaryLabel}
            ios="chevron.up.chevron.down"
            size={13}
          />
        </View>
      ) : (
        voiceValue
      )}
    </View>
  );
  const voiceRow = hasVoiceMenu ? (
    <MenuPickerMenu
      choices={voices.map((voice) => ({ key: voice.identifier, label: voiceLabel(voice) }))}
      label={t("Device voice")}
      onChange={(key) => {
        const voice = voices.find((candidate) => candidate.identifier === key);
        if (voice) void chooseVoice(voice);
      }}
      value={voiceId ?? ""}
    >
      {voiceRowContent}
    </MenuPickerMenu>
  ) : (
    voiceRowContent
  );

  return (
    <>
      <Stack.Screen options={glassHeaderOptions(t("Chat settings"))} />
      <ScrollView
        ref={scrollRef}
        style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
        contentContainerStyle={{ padding: 24 }}
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {bot ? (
          <View style={{ alignItems: "center", marginBottom: 24 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Edit avatar")}
              onPress={() => setAvatarOpen(true)}
              style={{ padding: 4 }}
            >
              <BotAvatar
                color={color}
                avatarSet={avatarSet}
                identity={bot.id}
                size={64}
                status={bot.status}
              />
              <View
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: 0,
                  padding: 4,
                  borderRadius: 12,
                  backgroundColor: tokens.card,
                }}
              >
                <NativeSymbol ios="pencil" android="pencil" size={12} color={tokens.foreground} />
              </View>
            </Pressable>
          </View>
        ) : null}
        <View style={{ alignItems: "center", gap: 4, marginTop: -16, marginBottom: -8 }}>
          <ProfileEditDialog
            label={t("Name")}
            editLabel={t("Edit name")}
            value={name}
            maxLength={BOT_NAME_MAX_LENGTH}
            large
            onCommit={async (value) => {
              if (value && botId) nameSave.update(value);
            }}
          />
        </View>
        <View style={{ marginTop: 24 }}>
          <SettingsGroup label={t("Notifications")}>
            <View style={styles.row}>
              <Text style={[styles.rowLabel, { color: tokens.foreground }]}>
                {t("When it finishes or needs input")}
              </Text>
              <NativeSwitch
                accessibilityLabel={t("When it finishes or needs input")}
                value={notifyOnFinish}
                onValueChange={(value) => notifySave.update(value)}
              />
            </View>
          </SettingsGroup>
        </View>
        {botId ? <BotContextCards key={botId} botId={botId} /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Advanced")}
          accessibilityState={{ expanded: advancedOpen }}
          onPress={() => setAdvancedOpen((open) => !open)}
          style={{
            marginTop: 24,
            minHeight: 44,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={[styles.sectionHeading, { color: tokens.mutedForeground }]}>
            {t("Advanced")}
          </Text>
          <Chevron expanded={advancedOpen} />
        </Pressable>
        {advancedOpen ? (
          <View
            style={{ gap: 24, marginTop: 24 }}
            onLayout={(event) => {
              modelY.current = event.nativeEvent.layout.y;
              if (focus === "model" || pickedModel !== undefined)
                scrollRef.current?.scrollTo({ y: modelY.current, animated: true });
            }}
          >
            <SettingsGroup label={t("Model")}>
              <MenuPicker
                plain
                choices={modelChoices}
                label={t("Model")}
                showLabel={false}
                onChange={selectModel}
                onPress={
                  modelChoices.length > MODEL_SEARCH_THRESHOLD
                    ? () =>
                        router.push({
                          pathname: "/bot-model",
                          params: { botId, value: selectedModelKey },
                        })
                    : undefined
                }
                value={selectedModelKey}
              />
              {thinkingOptions.length ? (
                <MenuPicker
                  plain
                  choices={thinkingChoices}
                  label={t("Thinking")}
                  onChange={setThinkingLevel}
                  value={thinkingLevel}
                />
              ) : null}
            </SettingsGroup>
            {modelMetaError ? (
              <Text style={{ color: tokens.mutedForeground, marginTop: 12, fontSize: 13 }}>
                {modelMetaError}
              </Text>
            ) : null}

            <SettingsGroup label={t("Computer")}>
              <ComputerModePicker plain value={computerMode} onChange={setComputerMode} />
            </SettingsGroup>
            <SettingsGroup label={t("Voice")}>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: tokens.foreground }]}>
                  {t("Read replies aloud")}
                </Text>
                <NativeSwitch
                  accessibilityLabel={t("Read replies aloud")}
                  onValueChange={setAutoSpeak}
                  value={autoSpeak}
                />
              </View>
              {deviceVoiceEnabled ? (
                voiceError ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("Device voice")}
                    accessibilityValue={{ text: voiceError }}
                    onPress={() => void retryDeviceVoices()}
                  >
                    {voiceRow}
                  </Pressable>
                ) : (
                  voiceRow
                )
              ) : null}
            </SettingsGroup>
            <SettingsGroup label={t("Permissions")}>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: tokens.foreground }]}>
                  {t("Allow cross-space bot communication")}
                </Text>
                <NativeSwitch
                  accessibilityLabel={t("Allow cross-space bot communication")}
                  value={crossSpaceCommunication}
                  onValueChange={(value) => {
                    if (!botId) return;
                    setError(null);
                    crossSpaceSave.update(value);
                  }}
                />
              </View>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: tokens.foreground }]}>
                  {t("Manage the bots it creates")}
                </Text>
                <NativeSwitch
                  accessibilityLabel={t("Manage the bots it creates")}
                  onValueChange={(value) => {
                    if (!botId) return;
                    setError(null);
                    fleetSave.update(value);
                  }}
                  value={fleetManagement}
                />
              </View>
            </SettingsGroup>
            <View>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingEnd: 16,
                  marginBottom: 8,
                }}
              >
                <SettingsSectionHeading>{t("Instructions")}</SettingsSectionHeading>
                {bot?.instructionHistory?.length && instructions === bot.instructions ? (
                  <View style={{ width: 44 }}>
                    <MenuPickerMenu
                      label={t("Instruction history")}
                      value=""
                      choices={bot.instructionHistory.map((version) => ({
                        key: version.id,
                        label: `${new Date(version.createdAt).toLocaleString()} (${version.reason})`,
                      }))}
                      onChange={(versionId) => {
                        if (pending || instructions !== bot.instructions) return;
                        const version = bot.instructionHistory?.find(
                          (item) => item.id === versionId,
                        );
                        if (version)
                          Alert.alert(t("Restore"), version.instructions, [
                            { text: t("Cancel"), style: "cancel" },
                            {
                              text: t("Restore"),
                              onPress: () => {
                                void rpc("bots/restoreInstructions", {
                                  botId: bot.id,
                                  versionId,
                                  expectedInstructions: bot.instructions,
                                })
                                  .then((updated) => {
                                    setBot(updated);
                                    setInstructions(updated.instructions ?? "");
                                  })
                                  .catch((err) => setError(errorText(err)));
                              },
                            },
                          ]);
                      }}
                    >
                      <View
                        accessible
                        accessibilityRole="button"
                        accessibilityLabel={t("Instruction history")}
                        style={{
                          minHeight: 44,
                          minWidth: 44,
                          alignItems: "flex-end",
                          justifyContent: "center",
                        }}
                      >
                        <NativeSymbol
                          ios="clock.arrow.circlepath"
                          android="time-outline"
                          size={18}
                          color={tokens.mutedForeground}
                        />
                      </View>
                    </MenuPickerMenu>
                  </View>
                ) : null}
              </View>
              <GrowingTextInput
                label={t("Instructions")}
                maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
                value={instructions}
                onChangeText={setInstructions}
                backgroundColor={native.fill}
              />
            </View>
            <SettingsGroup label={t("How other bots see it")}>
              <GrowingTextInput
                label={t("How other bots see it")}
                value={description}
                maxLength={BOT_DESCRIPTION_MAX_LENGTH}
                onChangeText={setDescription}
                placeholder={t("What this bot is for")}
                inset={0}
              />
            </SettingsGroup>
            <View style={{ paddingHorizontal: 16, borderRadius: 12, backgroundColor: native.fill }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Export")}
                style={styles.row}
                onPress={() => {
                  void rpc("export/bot", { botId })
                    .then((manifest) => Share.share({ message: JSON.stringify(manifest, null, 2) }))
                    .catch((err) => setError(errorText(err)));
                }}
              >
                <Text style={{ color: tokens.foreground, fontSize: 14 }}>{t("Export")}</Text>
                <NativeSymbol
                  ios="square.and.arrow.down"
                  android="download-outline"
                  size={18}
                  color={tokens.mutedForeground}
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Clear conversation")}
                style={[
                  styles.row,
                  { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: native.separator },
                ]}
                onPress={() =>
                  Alert.alert(t("Clear conversation"), undefined, [
                    { text: t("Cancel"), style: "cancel" },
                    {
                      text: t("Clear conversation"),
                      style: "destructive",
                      onPress: () => {
                        void rpc("threads/clear", { botId })
                          .then(() => router.back())
                          .catch((err) => setError(errorText(err)));
                      },
                    },
                  ])
                }
              >
                <Text style={{ color: tokens.destructive, fontSize: 14 }}>
                  {t("Clear conversation")}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
        {dirty ? (
          <NativeActionButton
            disabled={!name.trim() || pending || !bot}
            label={pending ? t("Saving…") : t("Save")}
            onPress={() => void save()}
            style={{ marginTop: 24 }}
          />
        ) : null}
      </ScrollView>
      {avatarOpen ? (
        <Modal
          visible={avatarOpen}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setAvatarOpen(false)}
        >
          <ScrollView
            contentContainerStyle={{ padding: 24, gap: 16 }}
            style={{ backgroundColor: tokens.background }}
          >
            <NativeActionButton label={t("Done")} onPress={() => setAvatarOpen(false)} />
            {bot && isAvatarPhoto(color) ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setColor(avatarColor(bot.color))}
                style={{ marginTop: 12 }}
              >
                <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>
                  {t("Remove photo")}
                </Text>
              </Pressable>
            ) : null}
            <MenuPicker
              label={t("Icon set")}
              choices={[
                { key: "organic", label: t("Original") },
                { key: "rakazo", label: t("Rakazo") },
              ]}
              value={avatarSet}
              onChange={(next) => {
                setAvatarSet(resolveBotAvatarSet(next));
                setColor((current) => avatarColor(current));
              }}
              plain
            />
            <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
              {t("Color")}
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 10, paddingVertical: 8, paddingHorizontal: 4 }}
              accessibilityRole="radiogroup"
            >
              {BOT_COLORS.map((option, index) => (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityLabel={t("Color {number}", { number: index + 1 })}
                  accessibilityState={{ checked: avatarColor(color) === option }}
                  onPress={() => setColor((current) => withAvatarColor(current, option))}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: option,
                    borderWidth: 3,
                    borderColor: avatarColor(color) === option ? tokens.foreground : "transparent",
                  }}
                />
              ))}
            </ScrollView>
            {bot && !isAvatarPhoto(color) ? (
              <>
                <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
                  {t("Shape")}
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 10, paddingVertical: 8, paddingHorizontal: 4 }}
                  accessibilityRole="radiogroup"
                >
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityLabel={t("Default")}
                    accessibilityState={{
                      checked: avatarSet === "organic" && avatarShape(color) === null,
                    }}
                    onPress={() => {
                      setAvatarSet("organic");
                      setColor((current) => avatarColor(current));
                    }}
                    style={{
                      padding: 4,
                      borderRadius: 14,
                      borderWidth: 2,
                      borderColor:
                        avatarSet === "organic" && avatarShape(color) === null
                          ? tokens.foreground
                          : "transparent",
                    }}
                  >
                    <BotAvatar color={avatarColor(color)} identity={bot.id} size={36} />
                  </Pressable>
                  {Array.from({ length: BOT_AVATAR_SHAPE_COUNT }, (_, shape) => (
                    <Pressable
                      key={shape}
                      accessibilityRole="radio"
                      accessibilityLabel={t("Shape {number}", { number: shape + 1 })}
                      accessibilityState={{ checked: avatarShape(color) === shape }}
                      onPress={() => {
                        setAvatarSet("organic");
                        setColor((current) => withAvatarShape(current, shape));
                      }}
                      style={{
                        padding: 4,
                        borderRadius: 14,
                        borderWidth: 2,
                        borderColor:
                          avatarShape(color) === shape ? tokens.foreground : "transparent",
                      }}
                    >
                      <BotAvatar
                        color={withAvatarShape(color, shape)}
                        identity={bot.id}
                        size={36}
                      />
                    </Pressable>
                  ))}
                </ScrollView>
              </>
            ) : null}
          </ScrollView>
        </Modal>
      ) : null}
    </>
  );
}

function SettingsSectionHeading({ children }: { children: string }) {
  const tokens = useMobileTokens();
  return (
    <Text
      accessibilityRole="header"
      style={[styles.sectionHeading, { color: tokens.mutedForeground }]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  sectionHeading: {
    fontSize: 12,
    fontWeight: "500",
    flexShrink: 1,
  },
  multilineField: {
    minHeight: 98,
    fontSize: 14,
    lineHeight: 22,
    padding: 16,
    textAlignVertical: "top",
  },
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  rowLabel: { fontSize: 14, flex: 1 },
  voiceTrigger: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowValue: { fontSize: 14, flexShrink: 1, textAlign: "right" },
});

function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <SettingsSectionHeading>{label}</SettingsSectionHeading>
      <View style={{ padding: 16, gap: 12, borderRadius: 12, backgroundColor: native.fill }}>
        {children}
      </View>
    </View>
  );
}

/** A noninteractive text copy gives loaded and edited content its full intrinsic height. */
function GrowingTextInput({
  label,
  value,
  onChangeText,
  maxLength,
  placeholder,
  backgroundColor,
  inset = 16,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  maxLength: number;
  placeholder?: string;
  backgroundColor?: ColorValue;
  inset?: number;
}) {
  const tokens = useMobileTokens();
  return (
    <View style={{ borderRadius: 11, backgroundColor }}>
      <Text
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.multilineField, { padding: inset, opacity: 0 }]}
      >
        {`${value || placeholder || ""}\u200b`}
      </Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        maxLength={maxLength}
        placeholder={placeholder}
        placeholderTextColor={tokens.mutedForeground}
        multiline
        scrollEnabled={false}
        style={[
          styles.multilineField,
          {
            color: tokens.foreground,
            padding: inset,
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
          },
        ]}
      />
    </View>
  );
}
