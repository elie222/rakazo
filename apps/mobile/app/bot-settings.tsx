import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Bot, BotAvatarSet, ComputerMode, ReplyMode, ThinkingLevel } from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  resolveBotAvatarSet,
} from "@rakazo/contracts";
import {
  botConnectionChanged,
  botLookState,
  connectionModelChoices,
  connectionPickerKey,
  credentialForModel,
  DEFAULT_BOT_AVATAR_COLOR,
  MODEL_SEARCH_THRESHOLD,
  modelOptionKey,
  parseModelOptionKey,
  pickBotModelChoice,
  resolveSelectableModelId,
} from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { Voice } from "expo-speech";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ScrollViewInstance } from "react-native";
import { Alert, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { BotContextCards } from "../components/bot-context-cards";
import { BotLookPicker } from "../components/bot-look-picker";
import { useComputerMaintenanceRows } from "../components/computer-maintenance-actions";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { glassHeaderOptions } from "../components/glass-title";
import { GrowingTextInput } from "../components/growing-text-input";
import type { MenuPickerChoice } from "../components/menu-picker";
import { MenuPicker, MenuPickerMenu } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSymbol } from "../components/native-symbol";
import { ProfileEditDialog } from "../components/profile-edit-dialog";
import { Chevron } from "../components/row-accessories";
import {
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  SettingsSwitch,
} from "../components/settings-group";
import { currentApiBase, rpc, selectedSpaceId } from "../lib/api";
import { deviceVoices, setVoiceForBot, voiceForBot, voiceLabel } from "../lib/bot-voices";
import { CallKeyboardContext } from "../lib/call-keyboard-context";
import { chatModelPickerChoices } from "../lib/chat-model";
import { COMPUTER_LIFECYCLE_TIMEOUT_MS } from "../lib/computer";
import { notifyConversationCleared } from "../lib/conversation-cleared";
import { loadDeviceVoiceEnabled } from "../lib/device-voice";
import { afterChatNotifyChange } from "../lib/live-notifications";
import type { MobileMe, MobileModel, MobileModelCredential } from "../lib/mobile-types";
import { native, useMobileTokens } from "../lib/native";
import { createQueuedSave } from "../lib/queued-save";
import { loadSessionToken } from "../lib/session";
import { useSideInsets } from "../lib/side-insets";
import { thinkingLevelLabel } from "../lib/thinking-level";
import { errorText } from "../lib/user-error";
import { stopVoicePlayback } from "../lib/voice";

export default function BotSettingsScreen() {
  const rootAvoidsKeyboard = useContext(CallKeyboardContext);
  const sideInsets = useSideInsets();
  const tokens = useMobileTokens();
  const { t } = useLingui();
  const router = useRouter();
  const {
    botId,
    model: pickedModel,
    focus,
  } = useLocalSearchParams<{ botId: string; model?: string; focus?: string }>();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const modelY = useRef(0);
  const [bot, setBot] = useState<Bot | null>(null);
  const threadId = useRef<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_BOT_AVATAR_COLOR);
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [avatarSet, setAvatarSet] = useState<BotAvatarSet>("organic");
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(focus === "model" || pickedModel !== undefined);
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [notifyOnFinish, setNotifyOnFinish] = useState(true);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [dailyCheckIns, setDailyCheckIns] = useState(true);
  const [crossSpaceCommunication, setCrossSpaceCommunication] = useState(true);
  const [fleetManagement, setFleetManagement] = useState(true);
  const [replyMode, setReplyMode] = useState<ReplyMode>("chat");
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [modelMetaReady, setModelMetaReady] = useState(false);
  const [modelMetaError, setModelMetaError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [savedConnection, setSavedConnection] = useState<{
    credentialId: string | null;
    pinned: boolean;
  } | null>(null);
  // Undefined until a row is picked; null when the picked row has no connection.
  const [pendingConnection, setPendingConnection] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const computerMaintenanceRows = useComputerMaintenanceRows(botId);
  const [deviceVoiceEnabled, setDeviceVoiceEnabled] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string | undefined>();
  const savedVoiceId = useRef<string | undefined>(undefined);
  const voiceChoice = useRef(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const crossSpaceSave = useMemo(
    () =>
      createQueuedSave<boolean>(false, {
        save: async (value) => {
          await rpc("bots/update", { botId, crossSpaceCommunication: value });
        },
        onChange: setCrossSpaceCommunication,
        onError: (err) => setError(errorText(err, t`Could not save bot`)),
      }),
    [botId, t],
  );
  const dailyCheckInsSave = useMemo(
    () =>
      createQueuedSave<boolean>(true, {
        save: async (value) => {
          await rpc("bots/update", { botId, dailyCheckIns: value });
        },
        onChange: setDailyCheckIns,
        onError: (err) => setError(errorText(err, t`Could not save bot`)),
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
        onError: (err) => setError(errorText(err, t`Could not save bot`)),
      }),
    [botId, t],
  );

  const replyModeSave = useMemo(
    () =>
      createQueuedSave<ReplyMode>("chat", {
        save: async (value) => {
          await rpc("bots/update", { botId, replyMode: value });
        },
        onChange: setReplyMode,
        onError: (err) => setError(errorText(err, t`Could not save bot`)),
      }),
    [botId, t],
  );

  const notifySave = useMemo(
    () =>
      createQueuedSave<boolean>(true, {
        save: async (notifyOnFinish) => {
          const next = await rpc("bots/update", { botId, notifyOnFinish });
          threadId.current = next.threadId;
        },
        onChange: setNotifyOnFinish,
        onSaved: async (notify) => {
          try {
            await afterChatNotifyChange(
              currentApiBase(),
              await loadSessionToken(),
              selectedSpaceId() ?? "",
              { botId, threadId: threadId.current, notify },
            );
          } catch {
            // The server save succeeded; device reconciliation can retry later.
          }
        },
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
        threadId.current = next.threadId;
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
        setDailyCheckIns(next.dailyCheckIns ?? true);
        dailyCheckInsSave.reset(next.dailyCheckIns ?? true);
        setCrossSpaceCommunication(next.crossSpaceCommunication ?? true);
        crossSpaceSave.reset(next.crossSpaceCommunication ?? true);
        setFleetManagement(next.fleetManagement);
        fleetSave.reset(next.fleetManagement);
        setReplyMode(next.replyMode);
        replyModeSave.reset(next.replyMode);
      })
      .catch((err) => setError(errorText(err, t`Could not load bot`)));
  }, [botId, dailyCheckInsSave, crossSpaceSave, fleetSave, replyModeSave, notifySave, nameSave]);

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
        setModelMetaError(errorText(err, t`Could not load model settings`));
      });
  }, [t]);

  // The answer is for one model, so ask again when the saved model changes.
  const savedProvider = bot?.modelProvider;
  const savedModelId = bot?.modelId;
  useEffect(() => {
    setConnectionError(null);
    setSavedConnection(null);
    if (!savedProvider || !savedModelId) return;
    let current = true;
    void rpc("bots/modelConnection", { botId })
      .then((next) => {
        if (current) setSavedConnection(next);
      })
      .catch((err) => {
        if (current) setConnectionError(errorText(err, t`Could not load model settings`));
      });
    return () => {
      current = false;
    };
  }, [botId, savedProvider, savedModelId, t]);

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
  const connectedOptions = useMemo(
    () => connectionModelChoices(credentials, catalog),
    [catalog, credentials],
  );
  const shownConnection =
    pendingConnection === undefined ? (savedConnection?.credentialId ?? null) : pendingConnection;
  const pickerValue = connectionPickerKey(connectedOptions, selectedModelKey, shownConnection);
  const connectionChanged = botConnectionChanged(pendingConnection, savedConnection);
  // Thinking levels belong to the connection, so read them from the one the bot will run on.
  const chosenCredential =
    shownConnection && pickerValue !== selectedModelKey
      ? credentials.find((credential) => credential.id === shownConnection)
      : undefined;
  const effectiveCredential =
    chosenCredential ?? credentialForModel(credentials, effectiveProvider, effectiveModelId);
  const thinkingOptions = (
    effectiveCredential?.thinkingLevels ??
    effectiveEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");

  const modelChoices = useMemo(
    () => chatModelPickerChoices(me, catalog, credentials, pickerValue, connectedOptions),
    [catalog, connectedOptions, credentials, me, pickerValue, t],
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
    const pick = pickBotModelChoice(key, {
      modelKey: selectedModelKey,
      thinkingLevel,
      credentials,
    });
    if (key === pickerValue && !pick.credentialId) return;
    setPendingConnection(pick.credentialId);
    setModelKey(pick.modelKey);
    if (pick.resetThinking) setThinkingLevel("");
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
      const sampleName = name.trim();
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

  async function save() {
    if (!botId || !bot || pendingRef.current) return;
    pendingRef.current = true;
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
        modelConnectionId?: string | null;
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
      if (pendingConnection || connectionChanged) input.modelConnectionId = pendingConnection;
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
        const {
          botId: _botId,
          expectedInstructions: _expected,
          modelConnectionId,
          ...saved
        } = input;
        setBot((prev) => (prev ? { ...prev, ...saved, ...updated } : prev));
        if (modelConnectionId !== undefined) {
          setSavedConnection({
            credentialId: modelConnectionId,
            pinned: modelConnectionId !== null,
          });
          setPendingConnection(undefined);
        }
      }
      await Promise.all([
        dailyCheckInsSave.flush(),
        crossSpaceSave.flush(),
        fleetSave.flush(),
        replyModeSave.flush(),
        notifySave.flush(),
        nameSave.flush(),
      ]);
      router.back();
    } catch (err) {
      setError(errorText(err, t`Could not save bot`));
    } finally {
      pendingRef.current = false;
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
      connectionChanged ||
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
            value={name}
            maxLength={BOT_NAME_MAX_LENGTH}
            large
            onCommit={async (value) => {
              if (value && botId) nameSave.update(value);
            }}
          />
        </View>
        <View style={{ marginTop: 24 }}>
          <SettingsGroup label={t`Notifications`}>
            <SettingsSwitch
              label={t`When it finishes or needs input`}
              value={notifyOnFinish}
              onChange={(value) => notifySave.update(value)}
            />
          </SettingsGroup>
        </View>
        {botId ? <BotContextCards key={botId} botId={botId} /> : null}
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
            <SettingsGroup label={t`Model`} footer={modelMetaError ?? connectionError ?? undefined}>
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
                          params: { botId, value: pickerValue },
                        })
                    : undefined
                }
                value={pickerValue}
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
            <SettingsGroup label={t`Computer`}>
              <View style={styles.cardContent}>
                <ComputerModePicker plain value={computerMode} onChange={setComputerMode} />
              </View>
              {computerMaintenanceRows}
            </SettingsGroup>
            <SettingsGroup label={t`Voice`}>
              <SettingsSwitch
                label={t`Read replies aloud`}
                onChange={setAutoSpeak}
                value={autoSpeak}
              />
              {deviceVoiceEnabled ? voiceRow : null}
            </SettingsGroup>
            <SettingsGroup label={t`Permissions`}>
              <SettingsSwitch
                label={t`Daily check-ins on unfinished work`}
                value={dailyCheckIns}
                onChange={(value) => {
                  if (!botId) return;
                  setError(null);
                  dailyCheckInsSave.update(value);
                }}
              />
              <SettingsSwitch
                label={t`Allow cross-space bot communication`}
                value={crossSpaceCommunication}
                onChange={(value) => {
                  if (!botId) return;
                  setError(null);
                  crossSpaceSave.update(value);
                }}
              />
              <SettingsSwitch
                label={t`Manage other bots`}
                onChange={(value) => {
                  if (!botId) return;
                  setError(null);
                  fleetSave.update(value);
                }}
                value={fleetManagement}
              />
            </SettingsGroup>
            <SettingsGroup label={t`Replies`}>
              <MenuPicker
                choices={[
                  { key: "chat", label: t`Chat` },
                  { key: "messages", label: t`Messages` },
                ]}
                label={t`Replies`}
                showLabel={false}
                onChange={(value) => {
                  if (!botId) return;
                  setError(null);
                  replyModeSave.update(value as ReplyMode);
                }}
                value={replyMode}
              />
            </SettingsGroup>
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
                        label: `${new Date(version.createdAt).toLocaleString()} (${version.reason})`,
                      }))}
                      onChange={(versionId) => {
                        if (pendingRef.current || instructions !== bot.instructions) return;
                        const version = bot.instructionHistory?.find(
                          (item) => item.id === versionId,
                        );
                        if (version)
                          Alert.alert(t`Restore`, version.instructions, [
                            { text: t`Cancel`, style: "cancel" },
                            {
                              text: t`Restore`,
                              onPress: () => {
                                if (pendingRef.current) return;
                                pendingRef.current = true;
                                setPending(true);
                                setError(null);
                                void rpc("bots/restoreInstructions", {
                                  botId: bot.id,
                                  versionId,
                                  expectedInstructions: bot.instructions,
                                })
                                  .then((updated) => {
                                    setBot(updated);
                                    setInstructions(updated.instructions ?? "");
                                  })
                                  .catch((err) => setError(errorText(err)))
                                  .finally(() => {
                                    pendingRef.current = false;
                                    setPending(false);
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
                onPress={() => {
                  void rpc("export/bot", { botId })
                    .then((manifest) => Share.share({ message: JSON.stringify(manifest, null, 2) }))
                    .catch((err) => setError(errorText(err)));
                }}
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
                      onPress: () => {
                        void rpc("threads/clear", { botId })
                          .then(() => notifyConversationCleared(botId))
                          .then(() => router.back())
                          .catch((err) => setError(errorText(err)));
                      },
                    },
                  ])
                }
              />
            </SettingsGroup>
          </View>
        ) : null}
        {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
        {dirty ? (
          <NativeActionButton
            disabled={!name.trim() || pending || !bot}
            label={pending ? t`Saving…` : t`Save`}
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

const styles = StyleSheet.create({
  cardContent: { padding: 16 },
  voiceError: { flexShrink: 1, fontSize: 17 },
});
