import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Bot, BotAvatarSet, ComputerMode, ThinkingLevel } from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  resolveBotAvatarSet,
} from "@rakazo/contracts";
import {
  botLookState,
  credentialForModel,
  DEFAULT_BOT_AVATAR_COLOR,
  MODEL_SEARCH_THRESHOLD,
  modelOptionKey,
  modelThinkingLevels,
  parseModelOptionKey,
  resolveSelectableModelId,
} from "@rakazo/core";
import { thinkingLevelLabel } from "@rakazo/i18n/thinking-level";
import { typeScale } from "@rakazo/ui-tokens";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { Voice } from "expo-speech";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ScrollViewInstance } from "react-native";
import { Alert, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "../components/bots/bot-avatar";
import { BotContextCards } from "../components/bots/bot-context-cards";
import { BotLookPicker } from "../components/bots/bot-look-picker";
import { ProfileEditDialog } from "../components/bots/profile-edit-dialog";
import { useComputerHomeVersionRows } from "../components/computers/computer-home-versions";
import { useComputerMaintenanceRows } from "../components/computers/computer-maintenance-actions";
import { glassHeaderOptions } from "../components/native/glass-title";
import { NativeActionButton } from "../components/native/native-action-button";
import { NativeSymbol } from "../components/native/native-symbol";
import {
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  SettingsSwitch,
} from "../components/settings/settings-group";
import { GrowingTextInput } from "../components/ui/growing-text-input";
import type { MenuPickerChoice } from "../components/ui/menu-picker";
import { MenuPicker, MenuPickerMenu } from "../components/ui/menu-picker";
import { Chevron } from "../components/ui/row-accessories";
import type { MobileModel, MobileModelCredential } from "../lib/api/mobile-types";
import { errorText } from "../lib/api/user-error";
import { botReadsIn, useBotSetting, useNotifyOnFinish } from "../lib/bots/bot-setting";
import { CallKeyboardContext } from "../lib/calls/call-keyboard-context";
import { COMPUTER_LIFECYCLE_TIMEOUT_MS } from "../lib/computers/computer";
import { dateLocaleForUi, useUiLocale } from "../lib/i18n/i18n";
import { useSideInsets } from "../lib/layout/side-insets";
import { chatModelPickerChoices } from "../lib/models/chat-model";
import { native, useMobileTokens } from "../lib/native/native";
import { formRead, rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { notifyConversationCleared } from "../lib/thread/conversation-cleared";
import { deviceVoices, setVoiceForBot, voiceForBot, voiceLabel } from "../lib/voice/bot-voices";
import { loadDeviceVoiceEnabled } from "../lib/voice/device-voice";
import { stopVoicePlayback } from "../lib/voice/voice";

/** Keyed by the bot, so nothing edited or saving for one bot reaches another opened in place. */
export default function BotSettingsScreen() {
  const { botId } = useLocalSearchParams<{ botId: string }>();
  return <BotSettings key={botId} />;
}

function BotSettings() {
  const rootAvoidsKeyboard = useContext(CallKeyboardContext);
  const sideInsets = useSideInsets();
  const tokens = useMobileTokens();
  const { t } = useLingui();
  const uiLocale = useUiLocale();
  const router = useRouter();
  const {
    botId,
    model: pickedModel,
    focus,
  } = useLocalSearchParams<{ botId: string; model?: string; focus?: string }>();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const modelY = useRef(0);
  const botQuery = useScreenQuery(formRead(rpcQuery("bots/get", { botId })), {
    enabled: Boolean(botId),
    onForeground: false,
  });
  const bot = botQuery.data ?? null;
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_BOT_AVATAR_COLOR);
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [avatarSet, setAvatarSet] = useState<BotAvatarSet>("organic");
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(focus === "model" || pickedModel !== undefined);
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(false);
  // A setting this screen no longer offers still shows while the bot has it changed from the
  // default, so it can be put back. Decided once, so the row stays to undo a change.
  const [changed, setChanged] = useState<{
    botId: string;
    readAloud: boolean;
    dailyCheckIns: boolean;
    crossSpaceCommunication: boolean;
    fleetManagement: boolean;
  } | null>(null);
  const meQuery = useScreenQuery(rpcQuery("me"));
  const catalogQuery = useScreenQuery(rpcQuery("models/list"));
  const credentialsQuery = useScreenQuery(rpcQuery("models/credentials"));
  const me = meQuery.data ?? null;
  const catalog = catalogQuery.data ?? NO_MODELS;
  const credentials = credentialsQuery.data ?? NO_CREDENTIALS;
  const modelMetaReady = Boolean(meQuery.data && catalogQuery.data && credentialsQuery.data);
  const modelMetaFailure = meQuery.error ?? catalogQuery.error ?? credentialsQuery.error;
  const modelMetaError =
    modelMetaFailure && !modelMetaReady
      ? errorText(modelMetaFailure, t`Could not load model settings`)
      : null;
  const [error, setError] = useState<string | null>(null);
  const shownError =
    error ?? (botQuery.error && !bot ? errorText(botQuery.error, t`Could not load bot`) : null);
  const computerMaintenanceRows = useComputerMaintenanceRows(botId);
  const computerHomeVersionRows = useComputerHomeVersionRows(botId);
  const [deviceVoiceEnabled, setDeviceVoiceEnabled] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string | undefined>();
  const savedVoiceId = useRef<string | undefined>(undefined);
  const voiceChoice = useRef(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const saveFailed = (failure: Error) => setError(errorText(failure, t`Could not save bot`));
  const nameSetting = useBotSetting(botId, "name", bot?.name ?? "", {
    onFailed: (failure) => setError(errorText(failure)),
  });
  const notify = useNotifyOnFinish(botId, bot?.notifyOnFinish ?? true, (failure) =>
    setError(errorText(failure)),
  );
  const dailyCheckIns = useBotSetting(botId, "dailyCheckIns", bot?.dailyCheckIns ?? true, {
    onFailed: saveFailed,
  });
  const crossSpace = useBotSetting(
    botId,
    "crossSpaceCommunication",
    bot?.crossSpaceCommunication ?? true,
    { onFailed: saveFailed },
  );
  const fleet = useBotSetting(botId, "fleetManagement", bot?.fleetManagement ?? true, {
    onFailed: saveFailed,
  });
  const reply = useBotSetting(botId, "notifyOnReply", bot?.notifyOnReply ?? true, {
    onFailed: saveFailed,
  });
  // Save leaves the screen, so it waits for the settings that save at once.
  const settingsSaving =
    nameSetting.pending ||
    notify.pending ||
    dailyCheckIns.pending ||
    crossSpace.pending ||
    fleet.pending ||
    reply.pending;

  // The form starts from the bot as read; a later read moves only the fields not edited since.
  const baseline = useRef<Bot | null>(null);
  useEffect(() => {
    const next = botQuery.data;
    if (!next) return;
    const previous = baseline.current;
    baseline.current = next;
    function follow<T>(set: Dispatch<SetStateAction<T>>, read: (from: Bot) => T) {
      set((current) => (!previous || current === read(previous) ? read(next!) : current));
    }
    follow(setDescription, (from) => from.description ?? "");
    follow(setInstructions, (from) => from.instructions ?? "");
    follow(setColor, (from) => from.color);
    follow(setAvatarSet, (from) => resolveBotAvatarSet(from.avatarSet));
    follow(setComputerMode, (from) => from.computerMode);
    follow(setModelKey, (from) =>
      from.modelProvider && from.modelId ? modelOptionKey(from.modelProvider, from.modelId) : "",
    );
    follow<string>(setThinkingLevel, (from) => from.thinkingLevel ?? "");
    follow(setAutoSpeak, (from) => from.autoSpeak);
    setChanged(
      (current) =>
        (current?.botId === next.id ? current : null) ?? {
          botId: next.id,
          readAloud: next.autoSpeak,
          dailyCheckIns: next.dailyCheckIns === false,
          crossSpaceCommunication: next.crossSpaceCommunication === false,
          fleetManagement: !next.fleetManagement,
        },
    );
  }, [botQuery.data]);

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
  const thinkingOptions = modelThinkingLevels(
    effectiveCredential,
    effectiveEntry,
    effectiveModelId,
  ).filter((level) => level !== "off");

  const modelChoices = useMemo(
    () => chatModelPickerChoices(me, catalog, credentials, selectedModelKey),
    [catalog, credentials, me, selectedModelKey, t],
  );

  const thinkingChoices: MenuPickerChoice[] = useMemo(
    () => [
      { key: "", label: t`Default` },
      ...thinkingOptions.map((level) => ({
        key: level,
        label: thinkingLevelLabel(level),
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
    setVoiceError(t`Could not load voices`);
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
      setError(t`Could not save that voice`);
      return;
    }
    if (choice !== voiceChoice.current) return;
    try {
      // Native speech loads only when a voice is previewed, as in lib/voice.
      const Speech = await import("expo-speech");
      if (choice !== voiceChoice.current) return;
      await Speech.stop();
      if (choice !== voiceChoice.current) return;
      const sampleName = nameSetting.value.trim();
      Speech.speak(
        sampleName ? t`Hi, I'm ${ph({ name: sampleName })}.` : t`Hi, this is how I'll sound.`,
        { voice: voice.identifier },
      );
    } catch {
      // The choice is already saved. A sample that cannot play is not a failed save.
    }
  }

  const currentVoice = voices.find((voice) => voice.identifier === voiceId);
  const currentVoiceLabel = currentVoice ? voiceLabel(currentVoice) : t`Default`;

  async function retryDeviceVoices() {
    if (!botId) return;
    try {
      const [available, assigned] = await Promise.all([deviceVoices(), voiceForBot(botId)]);
      applyVoices(available, assigned);
    } catch {
      failVoices();
    }
  }

  const restoring = useSave({
    save: async (input: { versionId: string; expectedInstructions: string }, send) => {
      const reads = botReadsIn(botId);
      reads.patch(await send("bots/restoreInstructions", { botId, ...input }));
    },
    onFailed: (failure) => setError(errorText(failure)),
  });
  const saving = useSave({
    save: async (_, send) => {
      const reads = botReadsIn(botId);
      if (!bot) return;
      const selected = selectedModel;
      const update: {
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
      if (description.trim() !== (bot.description ?? "")) update.description = description.trim();
      if (instructions !== bot.instructions) {
        update.instructions = instructions;
        update.expectedInstructions = bot.instructions;
      }
      if (color !== bot.color) update.color = color;
      if (avatarSet !== resolveBotAvatarSet(bot.avatarSet)) update.avatarSet = avatarSet;
      const modelChanged =
        (selected?.provider ?? null) !== (bot.modelProvider ?? null) ||
        (selected?.modelId ?? null) !== (bot.modelId ?? null);
      const thinkingChanged = (thinkingLevel || null) !== (bot.thinkingLevel ?? null);
      if (modelChanged) {
        update.modelProvider = selected?.provider ?? null;
        update.modelId = selected?.modelId ?? null;
      }
      if (modelMetaReady && (modelChanged || thinkingChanged)) {
        update.thinkingLevel = thinkingOptions.length
          ? ((thinkingLevel || null) as ThinkingLevel | null)
          : null;
      }
      if (autoSpeak !== bot.autoSpeak) update.autoSpeak = autoSpeak;
      if (computerMode !== bot.computerMode) {
        await send(
          "bots/setComputer",
          { botId, mode: computerMode },
          { timeoutMs: COMPUTER_LIFECYCLE_TIMEOUT_MS },
        );
        reads.patch({ computerMode });
      }
      // Use key presence so clearing description to "" still persists.
      if (Object.keys(update).length > 1) {
        const updated = await send("bots/update", update);
        // Saved edits and their history become the baseline, so a retry does not resend them.
        const { botId: _botId, expectedInstructions: _expected, ...saved } = update;
        reads.patch({ ...saved, ...updated });
      }
    },
    onSaved: () => router.back(),
    onFailed: (failure) => setError(errorText(failure, t`Could not save bot`)),
    closesScreen: true,
  });
  const pending = saving.pending || restoring.pending;
  function save() {
    if (!botId || !bot || pending || settingsSaving) return;
    setError(null);
    saving.run();
  }
  const exportBot = useSave({
    save: async (_, send) => {
      const manifest = await send("export/bot", { botId });
      await Share.share({ message: JSON.stringify(manifest, null, 2) });
    },
    onFailed: (failure) => setError(errorText(failure)),
  });
  const clearConversation = useSave({
    save: async (_, send) => {
      await send("threads/clear", { botId });
      notifyConversationCleared(botId);
    },
    onSaved: () => router.back(),
    onFailed: (failure) => setError(errorText(failure)),
    closesScreen: true,
  });

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

  const hasVoiceMenu = !voiceError && voices.length > 1;
  const voiceRowContent = (
    <SettingsRow
      accessible
      accessibilityLabel={t`Device voice`}
      accessibilityRole={hasVoiceMenu || voiceError ? "button" : undefined}
      accessibilityValue={{ text: voiceError ?? currentVoiceLabel }}
      onPress={voiceError ? () => void retryDeviceVoices() : undefined}
      title={t`Device voice`}
      value={voiceError ? undefined : currentVoiceLabel}
      trailing={
        voiceError ? (
          <Text numberOfLines={1} style={[styles.voiceError, { color: tokens.destructive }]}>
            {voiceError}
          </Text>
        ) : hasVoiceMenu ? (
          <NativeSymbol
            android="chevron-expand"
            color={native.tertiaryLabel}
            ios="chevron.up.chevron.down"
            size={13}
          />
        ) : undefined
      }
    />
  );
  const voiceRow = hasVoiceMenu ? (
    <MenuPickerMenu
      choices={voices.map((voice) => ({ key: voice.identifier, label: voiceLabel(voice) }))}
      label={t`Device voice`}
      onChange={(key) => {
        const voice = voices.find((candidate) => candidate.identifier === key);
        if (voice) void chooseVoice(voice);
      }}
      value={voiceId ?? ""}
    >
      <View>{voiceRowContent}</View>
    </MenuPickerMenu>
  ) : (
    voiceRowContent
  );

  return (
    <>
      <Stack.Screen options={glassHeaderOptions(t`Chat settings`)} />
      <ScrollView
        ref={scrollRef}
        style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
        contentContainerStyle={{ padding: 24 }}
        automaticallyAdjustKeyboardInsets={!rootAvoidsKeyboard}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {bot ? (
          <View style={{ alignItems: "center", marginBottom: 24 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t`Edit avatar`}
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
            label={t`Name`}
            editLabel={t`Edit name`}
            value={nameSetting.value}
            maxLength={BOT_NAME_MAX_LENGTH}
            large
            onCommit={async (value) => {
              if (value && botId && !saving.pending) nameSetting.set(value);
            }}
          />
        </View>
        <View style={{ marginTop: 24 }}>
          <SettingsGroup label={t`Notifications`}>
            <SettingsSwitch
              label={t`When it needs input`}
              value={notify.value}
              disabled={saving.pending}
              onChange={notify.set}
            />
            {notify.value ? (
              <SettingsSwitch
                label={t`When it finishes`}
                value={reply.value}
                disabled={saving.pending}
                onChange={reply.set}
              />
            ) : null}
          </SettingsGroup>
        </View>
        {botId ? <BotContextCards key={`${botId}-work`} botId={botId} section="work" /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t`Advanced`}
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
          <Text style={{ color: native.secondaryLabel, ...typeScale.caption, paddingStart: 16 }}>
            {t`Advanced`}
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
            {botId ? (
              <BotContextCards key={`${botId}-memory`} botId={botId} section="memory" />
            ) : null}
            <SettingsGroup label={t`Model`} footer={modelMetaError ?? undefined}>
              <MenuPicker
                choices={modelChoices}
                label={t`Model`}
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
                  choices={thinkingChoices}
                  label={t`Thinking`}
                  onChange={setThinkingLevel}
                  value={thinkingLevel}
                />
              ) : null}
            </SettingsGroup>
            <SettingsGroup>
              <SettingsSwitch
                label={t`Own computer`}
                value={computerMode === "dedicated"}
                onChange={(value) => setComputerMode(value ? "dedicated" : "team")}
              />
              {computerMaintenanceRows}
              {computerHomeVersionRows}
            </SettingsGroup>
            {changed?.readAloud || deviceVoiceEnabled ? (
              <SettingsGroup label={t`Voice`}>
                {changed?.readAloud ? (
                  <SettingsSwitch
                    label={t`Read replies aloud`}
                    onChange={setAutoSpeak}
                    value={autoSpeak}
                  />
                ) : null}
                {deviceVoiceEnabled ? voiceRow : null}
              </SettingsGroup>
            ) : null}
            {changed?.dailyCheckIns ||
            changed?.crossSpaceCommunication ||
            changed?.fleetManagement ? (
              <SettingsGroup label={t`Permissions`}>
                {changed.dailyCheckIns ? (
                  <SettingsSwitch
                    label={t`Daily check-ins on unfinished work`}
                    value={dailyCheckIns.value}
                    disabled={saving.pending}
                    onChange={(value) => {
                      if (!botId) return;
                      setError(null);
                      dailyCheckIns.set(value);
                    }}
                  />
                ) : null}
                {changed.crossSpaceCommunication ? (
                  <SettingsSwitch
                    label={t`Allow cross-space bot communication`}
                    value={crossSpace.value}
                    disabled={saving.pending}
                    onChange={(value) => {
                      if (!botId) return;
                      setError(null);
                      crossSpace.set(value);
                    }}
                  />
                ) : null}
                {changed.fleetManagement ? (
                  <SettingsSwitch
                    label={t`Manage other bots`}
                    onChange={(value) => {
                      if (!botId) return;
                      setError(null);
                      fleet.set(value);
                    }}
                    value={fleet.value}
                    disabled={saving.pending}
                  />
                ) : null}
              </SettingsGroup>
            ) : null}
            <View style={{ gap: 7 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingEnd: 16,
                }}
              >
                <SettingsLabel>{t`Instructions`}</SettingsLabel>
                {bot?.instructionHistory?.length && instructions === bot.instructions ? (
                  <View style={{ width: 44 }}>
                    <MenuPickerMenu
                      label={t`Instruction history`}
                      value=""
                      choices={bot.instructionHistory.map((version) => ({
                        key: version.id,
                        label: `${new Date(version.createdAt).toLocaleString(dateLocaleForUi(uiLocale))} (${version.reason})`,
                      }))}
                      onChange={(versionId) => {
                        if (pending || instructions !== bot.instructions) return;
                        const version = bot.instructionHistory?.find(
                          (item) => item.id === versionId,
                        );
                        if (version)
                          Alert.alert(t`Restore`, version.instructions, [
                            { text: t`Cancel`, style: "cancel" },
                            {
                              text: t`Restore`,
                              onPress: () => {
                                setError(null);
                                if (saving.pending) return;
                                restoring.run({
                                  versionId,
                                  expectedInstructions: bot.instructions ?? "",
                                });
                              },
                            },
                          ]);
                      }}
                    >
                      <View
                        accessible
                        accessibilityRole="button"
                        accessibilityLabel={t`Instruction history`}
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
                label={t`Instructions`}
                maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
                value={instructions}
                editable={!pending}
                onChangeText={setInstructions}
                backgroundColor={native.groupedCell}
                fontSize={17}
              />
            </View>
            <SettingsGroup label={t`How other bots see it`}>
              <GrowingTextInput
                label={t`How other bots see it`}
                value={description}
                maxLength={BOT_DESCRIPTION_MAX_LENGTH}
                onChangeText={setDescription}
                placeholder={t`What this bot is for`}
                fontSize={17}
              />
            </SettingsGroup>
            <SettingsGroup>
              <SettingsRow
                accessibilityRole="button"
                title={t`Export`}
                trailing={
                  <NativeSymbol
                    ios="square.and.arrow.down"
                    android="download-outline"
                    size={18}
                    color={native.tertiaryLabel}
                  />
                }
                onPress={() => exportBot.run()}
              />
              <SettingsRow
                accessibilityRole="button"
                destructive
                title={t`Clear conversation`}
                onPress={() =>
                  Alert.alert(t`Clear conversation`, undefined, [
                    { text: t`Cancel`, style: "cancel" },
                    {
                      text: t`Clear conversation`,
                      style: "destructive",
                      onPress: () => clearConversation.run(),
                    },
                  ])
                }
              />
            </SettingsGroup>
          </View>
        ) : null}
        {shownError ? (
          <Text style={{ color: tokens.destructive, marginTop: 16 }}>{shownError}</Text>
        ) : null}
        {dirty ? (
          <NativeActionButton
            disabled={!nameSetting.value.trim() || pending || settingsSaving || !bot}
            label={pending ? t`Saving…` : t`Save`}
            onPress={save}
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
            <NativeActionButton label={t`Done`} onPress={() => setAvatarOpen(false)} />
            {bot && botLookState(color).photo ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setColor(botLookState(bot.color).color)}
                style={{ marginTop: 12 }}
              >
                <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>
                  {t`Remove photo`}
                </Text>
              </Pressable>
            ) : null}
            <MenuPicker
              label={t`Icon set`}
              choices={[
                { key: "organic", label: t`Original` },
                { key: "rakazo", label: t`Rakazo` },
              ]}
              value={avatarSet}
              onChange={(next) => {
                setAvatarSet(resolveBotAvatarSet(next));
                setColor((current) => botLookState(current).color);
              }}
              plain
            />
            {bot ? (
              <BotLookPicker
                value={color}
                identity={bot.id}
                avatarSet={avatarSet}
                onChange={(next) => setColor(next)}
              />
            ) : null}
          </ScrollView>
        </Modal>
      ) : null}
    </>
  );
}

const NO_MODELS: MobileModel[] = [];
const NO_CREDENTIALS: MobileModelCredential[] = [];

const styles = StyleSheet.create({
  voiceError: { flexShrink: 1, fontSize: 17 },
});
