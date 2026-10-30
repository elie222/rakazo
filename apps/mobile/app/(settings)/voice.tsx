import type { VoiceCatalogEntry, VoiceCredential, VoiceInfo, VoiceStatus } from "@rakazo/contracts";
import {
  DEFAULT_COMPATIBLE_STT_MODEL,
  DEFAULT_COMPATIBLE_TTS_MODEL,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import { isCancelledError } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSwitch } from "../../components/native-switch";
import { Checkmark } from "../../components/row-accessories";
import { mobileTokens } from "../../lib/appearance";
import {
  loadCallSoundsEnabled,
  loadWaitSoundEnabled,
  playCallCue,
  saveCallSoundsEnabled,
  saveWaitSoundEnabled,
} from "../../lib/call-sounds";
import { loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } from "../../lib/device-voice";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { queryClient, rpcQuery } from "../../lib/query";
import type { SettingsTarget } from "../../lib/settings-target";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";
import { speakText } from "../../lib/voice";

type VoiceField = "voiceId" | "speechModel" | "baseUrl" | "ttsModel" | "sttModel";

/** A Space's override is read from that Space even when another one is selected. */
const targetSpace = (target: SettingsTarget) =>
  target.scope === "space" ? target.spaceId : undefined;
const voiceReads = (target: SettingsTarget) => {
  const input = { scope: target.scope };
  const spaceId = targetSpace(target);
  return {
    catalog: rpcQuery("voice/catalog", undefined, spaceId),
    credentials: rpcQuery("voice/credentials", input, spaceId),
    status: rpcQuery("voice/status", input, spaceId),
  };
};
const voicesRead = (target: SettingsTarget, provider: string) =>
  rpcQuery("voice/voices", { provider, scope: target.scope }, targetSpace(target));

function pickProvider(catalog: VoiceCatalogEntry[], status: VoiceStatus, preferred?: string) {
  return (
    [preferred, status.provider].find((id) => catalog.some((entry) => entry.id === id)) ??
    catalog[0]?.id ??
    ""
  );
}

/** What this screen showed last in this space, so a revisit paints it before refreshing. */
function cachedVoiceSettings(target: SettingsTarget) {
  const reads = voiceReads(target);
  const catalog = queryClient.getQueryData(reads.catalog.queryKey);
  const credentials = queryClient.getQueryData(reads.credentials.queryKey);
  const status = queryClient.getQueryData(reads.status.queryKey);
  if (!catalog || !credentials || !status) return null;
  const provider = pickProvider(catalog, status);
  const credential = credentials.find((entry) => entry.provider === provider);
  const voices = credential ? queryClient.getQueryData(voicesRead(target, provider).queryKey) : [];
  return { catalog, credentials, status, provider, credential, voices: voices ?? [] };
}

/**
 * The voice that reads replies out loud. Opened with a Space, it edits that Space's override;
 * this device's voice and sounds stay with the device, so only the account's screen shows them.
 */
export default function VoiceSettings() {
  const params = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(params.spaceId), [params.spaceId]);
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const deviceSettings = scope === "account";
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createVoiceStyles);
  const { t } = useI18n();
  const [cached] = useState(() => cachedVoiceSettings(target));
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>(cached?.catalog ?? []);
  const [credentials, setCredentials] = useState<VoiceCredential[]>(cached?.credentials ?? []);
  const [status, setStatus] = useState<VoiceStatus | null>(cached?.status ?? null);
  const [voices, setVoices] = useState<VoiceInfo[]>(cached?.voices ?? []);
  const [provider, setProvider] = useState(cached?.provider ?? "");
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState(cached?.credential?.voiceId ?? "");
  const [speechModel, setSpeechModel] = useState(cached?.credential?.speechModel ?? "");
  const [baseUrl, setBaseUrl] = useState(cached?.credential?.endpoint ?? "");
  const [ttsModel, setTtsModel] = useState(cached?.credential?.ttsModel ?? "");
  const [sttModel, setSttModel] = useState(cached?.credential?.sttModel ?? "");
  // Fields typed into since the last load; an opening refresh keeps them.
  const edited = useRef(new Set<VoiceField>());
  // Every load and action bumps this, so an older refresh never lands over a newer choice.
  const loadRevision = useRef(0);
  const speechModelSave = useRef<string | null>(null);
  const [deviceVoice, setDeviceVoice] = useState(false);
  const [deviceVoiceReady, setDeviceVoiceReady] = useState(!deviceSettings);
  const [callSounds, setCallSounds] = useState<boolean | null>(null);
  const [waitSound, setWaitSound] = useState<boolean | null>(null);
  // Prevent stale reads from overwriting a saved preference.
  const soundPrefsRevision = useRef(0);
  const soundPrefSaving = useRef(false);
  // Only the first visit waits; a revisit paints what it saw last and refreshes behind it.
  const [loading, setLoading] = useState(!cached);
  const [pending, setPending] = useState<
    "connect" | "disconnect" | "voice" | "speech" | "test" | "device-voice" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const deviceVoiceRevision = useRef(0);
  const deviceVoiceSaveInFlight = useRef(false);

  /**
   * Opening keeps fields typed into meanwhile and may share a read already in flight; after a
   * change, every field takes the server's value from a read sent afterwards.
   */
  const load = useCallback(
    async (nextProvider?: string, opening = false) => {
      const revision = ++loadRevision.current;
      if (!opening) edited.current.clear();
      const reads = voiceReads(target);
      const reuse = { reuse: opening };
      const [nextCatalog, nextCredentials, nextStatus] = await Promise.all([
        fetchFresh(queryClient, reads.catalog, reuse),
        fetchFresh(queryClient, reads.credentials, reuse),
        fetchFresh(queryClient, reads.status, reuse),
      ]);
      if (revision !== loadRevision.current) return;
      setLoadError(null);
      const selected = pickProvider(nextCatalog, nextStatus, nextProvider);
      setCatalog(nextCatalog);
      setCredentials(nextCredentials);
      setStatus(nextStatus);
      setProvider(selected);
      const cred = nextCredentials.find((entry) => entry.provider === selected);
      const fields: [VoiceField, (value: string) => void, string | undefined][] = [
        ["voiceId", setVoiceId, cred?.voiceId],
        ["speechModel", setSpeechModel, cred?.speechModel],
        ["baseUrl", setBaseUrl, cred?.endpoint],
        ["ttsModel", setTtsModel, cred?.ttsModel],
        ["sttModel", setSttModel, cred?.sttModel],
      ];
      for (const [field, set, value] of fields) if (!edited.current.has(field)) set(value ?? "");
      if (cred) {
        const nextVoices = await fetchFresh(queryClient, voicesRead(target, selected), reuse);
        if (revision === loadRevision.current) setVoices(nextVoices);
      } else {
        setVoices([]);
      }
    },
    [target],
  );

  const edit = (field: VoiceField, set: (value: string) => void) => (value: string) => {
    edited.current.add(field);
    set(value);
  };

  const open = useCallback(() => {
    void load(undefined, true)
      .catch((err: unknown) => {
        // A newer read replaced this one and reports for both.
        if (!isCancelledError(err))
          setLoadError(errorText(err, t("Could not load voice settings")));
      })
      .finally(() => setLoading(false));
  }, [load, t]);

  useFocusEffect(
    useCallback(() => {
      open();
      if (!deviceSettings) return;
      const revision = ++deviceVoiceRevision.current;
      void loadDeviceVoiceEnabled()
        .then((value) => {
          if (deviceVoiceSaveInFlight.current) return;
          if (deviceVoiceRevision.current !== revision) return;
          setDeviceVoice(value);
          setDeviceVoiceReady(true);
        })
        .catch((err: unknown) => {
          if (deviceVoiceSaveInFlight.current) return;
          if (deviceVoiceRevision.current !== revision) return;
          setDeviceVoiceReady(true);
          setError(errorText(err, t("Could not load voice settings")));
        });
      const soundRevision = soundPrefsRevision.current;
      void Promise.allSettled([loadCallSoundsEnabled(), loadWaitSoundEnabled()]).then(
        ([calls, waiting]) => {
          if (soundPrefSaving.current || soundPrefsRevision.current !== soundRevision) return;
          setCallSounds(calls.status === "fulfilled" ? calls.value : null);
          setWaitSound(waiting.status === "fulfilled" ? waiting.value : null);
          const failed = [calls, waiting].find((result) => result.status === "rejected");
          if (failed?.status === "rejected") {
            setError(errorText(failed.reason, t("Could not load voice settings")));
          }
        },
      );
    }, [deviceSettings, open, t]),
  );

  /** One sound-switch save at a time; a failed save rolls back only that switch. */
  async function saveSoundPref(
    next: boolean,
    show: (value: boolean) => void,
    save: (value: boolean) => Promise<void>,
  ): Promise<boolean> {
    if (soundPrefSaving.current) return false;
    soundPrefSaving.current = true;
    soundPrefsRevision.current += 1;
    show(next);
    try {
      await save(next);
      return true;
    } catch {
      show(!next);
      setError(t("Could not save that preference"));
      return false;
    } finally {
      soundPrefSaving.current = false;
      soundPrefsRevision.current += 1;
    }
  }

  async function toggleWaitSound(next: boolean) {
    if (waitSound === null) return;
    await saveSoundPref(next, setWaitSound, saveWaitSoundEnabled);
  }

  async function toggleCallSounds(next: boolean) {
    if (callSounds === null) return;
    const saved = await saveSoundPref(next, setCallSounds, saveCallSoundsEnabled);
    // The preview is a courtesy: if it cannot play, the saved choice still stands.
    if (saved && next) await playCallCue("start").catch(() => undefined);
  }

  async function saveDeviceVoice(next: boolean): Promise<boolean> {
    deviceVoiceSaveInFlight.current = true;
    deviceVoiceRevision.current++;
    setDeviceVoice(next);
    try {
      await saveDeviceVoiceEnabled(next);
      return true;
    } catch (err) {
      setDeviceVoice(!next);
      setError(errorText(err, t("Could not save that preference")));
      return false;
    } finally {
      deviceVoiceSaveInFlight.current = false;
      deviceVoiceRevision.current++;
    }
  }

  async function toggleDeviceVoice() {
    if (pending !== null || !deviceVoiceReady) return;
    setPending("device-voice");
    setError(null);
    if (status) setLoadError(null);
    try {
      await saveDeviceVoice(!deviceVoice);
    } finally {
      setPending(null);
    }
  }

  async function chooseProvider(nextProvider: string) {
    if (pending !== null || !deviceVoiceReady) return;
    const wasDeviceVoice = deviceVoice;
    const previousProvider = provider;
    loadRevision.current++;
    setPending("voice");
    setError(null);
    if (status) setLoadError(null);
    try {
      if (deviceSettings && !(await saveDeviceVoice(false))) return;
      setProvider(nextProvider);
      const cred = credentials.find((entry) => entry.provider === nextProvider);
      if (cred?.voiceId && status?.provider !== nextProvider) {
        try {
          const saved = await rpc("voice/setVoice", {
            voiceId: cred.voiceId,
            provider: nextProvider,
            scope,
          });
          setStatus(saved);
          await writeSaved(queryClient, voiceReads(target).status.queryKey, () => saved);
        } catch (err) {
          setProvider(previousProvider);
          if (wasDeviceVoice && !(await saveDeviceVoice(true))) return;
          setError(errorText(err, t("Could not save that voice")));
          return;
        }
      }
      setApiKey("");
      setVoiceId(cred?.voiceId ?? "");
      setSpeechModel(cred?.speechModel ?? "");
      setVoices([]);
      try {
        await load(nextProvider);
      } catch (err) {
        // A refresh failure must not leave another provider's voices available.
        setVoices([]);
        setError(errorText(err, t("Could not load voice settings")));
      }
    } finally {
      setPending(null);
    }
  }

  const selected = catalog.find((entry) => entry.id === provider);
  const credential = credentials.find((entry) => entry.provider === provider);
  const hiddenSelfHosted =
    !catalog.some((entry) => entry.id === OPENAI_COMPATIBLE_PROVIDER_ID) &&
    credentials.some((entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID);

  const selfHosted = selected?.id === OPENAI_COMPATIBLE_PROVIDER_ID;
  const keyless = Boolean(selected?.keyless);
  const canConnect = keyless || (selfHosted ? Boolean(baseUrl.trim()) : apiKey.trim().length >= 8);

  async function connect() {
    if (!selected || !canConnect) return;
    setPending("connect");
    setError(null);
    if (status) setLoadError(null);
    try {
      await rpc("voice/connect", {
        provider: selected.id,
        scope,
        apiKey: apiKey.trim(),
        // The server drops this voice when the address or speech model really changed.
        voiceId: voiceId || undefined,
        ...(selected.id === "fish-audio" ? { speechModel: speechModel.trim() } : {}),
        ...(selfHosted
          ? {
              baseUrl: baseUrl.trim(),
              ttsModel: ttsModel.trim() || undefined,
              sttModel: sttModel.trim() || undefined,
            }
          : {}),
      });
      setApiKey("");
      await load(selected.id);
    } catch (err) {
      setError(errorText(err, t("Could not connect")));
    } finally {
      setPending(null);
    }
  }

  async function disconnect(providerId = credential?.provider) {
    if (!providerId) return;
    setPending("disconnect");
    setError(null);
    if (status) setLoadError(null);
    try {
      await rpc("voice/disconnect", { provider: providerId });
      setApiKey("");
      await load(providerId);
    } catch (err) {
      setError(errorText(err, t("Could not disconnect")));
    } finally {
      setPending(null);
    }
  }

  async function saveSpeechModel() {
    if (!credential || selected?.id !== "fish-audio" || pending !== null) return;
    const next = speechModel.trim();
    if (next === (credential.speechModel ?? "")) return;
    if (speechModelSave.current === next) return;
    speechModelSave.current = next;
    setPending("speech");
    setError(null);
    if (status) setLoadError(null);
    try {
      const saved = await rpc("voice/setSpeechModel", {
        provider: selected.id,
        scope,
        speechModel: next,
      });
      const merge = (current: VoiceCredential[] = []) =>
        current.map((entry) => (entry.id === saved.id ? { ...entry, ...saved } : entry));
      // A read still out started before this save, so it must not land; read again after it.
      loadRevision.current++;
      edited.current.delete("speechModel");
      setSpeechModel(saved.speechModel ?? "");
      setCredentials(merge);
      await writeSaved(queryClient, voiceReads(target).credentials.queryKey, merge);
      void load(selected.id, true).catch(() => undefined);
    } catch (err) {
      setError(errorText(err, t("Could not save that speech model")));
    } finally {
      speechModelSave.current = null;
      setPending(null);
    }
  }

  async function chooseVoice(nextVoiceId: string) {
    loadRevision.current++;
    setVoiceId(nextVoiceId);
    setPending("voice");
    try {
      await rpc("voice/setVoice", { voiceId: nextVoiceId, provider: selected?.id, scope });
      await load(selected?.id);
    } catch (err) {
      setError(errorText(err, t("Could not save that voice")));
    } finally {
      setPending(null);
    }
  }

  async function testVoice() {
    setPending("test");
    setError(null);
    if (status) setLoadError(null);
    try {
      const ready = await speakText(t("Hi, this is how I'll sound when I read replies out loud."), {
        scope,
      });
      if (!ready) {
        throw new Error(t("Connect a voice provider first."));
      }
    } catch (err) {
      setError(errorText(err, t("Could not play a sample")));
    } finally {
      setPending(null);
    }
  }

  const failure = error ?? loadError;
  const shownError = error ?? (status ? loadError : null);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {loading || !deviceVoiceReady ? <ActivityIndicator color={native.secondaryLabel} /> : null}
        {failure && !status ? (
          <LoadFailure
            message={failure}
            onRetry={() => {
              setLoadError(null);
              setLoading(true);
              open();
            }}
          />
        ) : shownError ? (
          <Text style={styles.error}>{shownError}</Text>
        ) : null}
        {deviceSettings ? (
          <View style={styles.group}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: deviceVoice }}
              disabled={pending !== null || !deviceVoiceReady}
              onPress={() => void toggleDeviceVoice()}
              style={({ pressed }) => [
                styles.groupRow,
                (pending !== null || !deviceVoiceReady) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.rowCopy}>
                <Text style={styles.cardTitle}>{t("This device")}</Text>
              </View>
              {deviceVoice ? <Checkmark /> : null}
            </Pressable>
          </View>
        ) : null}
        {catalog.length ? (
          <View style={styles.group}>
            {catalog.map((entry, index) => {
              const chosen = deviceVoiceReady && !deviceVoice && provider === entry.id;
              return (
                <Pressable
                  key={entry.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: chosen }}
                  disabled={pending !== null || !deviceVoiceReady}
                  onPress={() => void chooseProvider(entry.id)}
                  style={({ pressed }) => [
                    styles.groupRow,
                    index > 0 && styles.groupDivider,
                    (pending !== null || !deviceVoiceReady) && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.rowCopy}>
                    <Text style={styles.cardTitle}>{entry.name}</Text>
                  </View>
                  {chosen ? <Checkmark /> : null}
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {/* Connections belong to the account, so a space never removes them. */}
        {hiddenSelfHosted && scope === "account" ? (
          <NativeActionButton
            label={t("Disconnect Self-hosted")}
            prominence="quiet"
            disabled={pending !== null}
            onPress={() => void disconnect(OPENAI_COMPATIBLE_PROVIDER_ID)}
          />
        ) : null}
        {selected && deviceVoiceReady && !deviceVoice ? (
          <>
            {selfHosted ? (
              <TextInput
                accessibilityLabel={t("Server URL")}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                inputMode="url"
                keyboardType="url"
                value={baseUrl}
                onChangeText={edit("baseUrl", setBaseUrl)}
                placeholder="http://192.168.1.10:8880/v1"
                placeholderTextColor={native.tertiaryLabel}
                style={styles.input}
                textContentType="URL"
              />
            ) : null}
            {keyless ? null : (
              <TextInput
                accessibilityLabel={t("API key")}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                importantForAutofill="no"
                value={apiKey}
                onChangeText={setApiKey}
                placeholder={
                  selfHosted
                    ? t("Optional")
                    : credential
                      ? t("Paste a replacement key")
                      : t("Paste your API key")
                }
                placeholderTextColor={native.tertiaryLabel}
                secureTextEntry
                style={styles.input}
                textContentType="none"
              />
            )}
            {selfHosted ? (
              <>
                <Text style={styles.fieldLabel}>{t("Speech model")}</Text>
                <TextInput
                  accessibilityLabel={t("Speech model")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={ttsModel}
                  onChangeText={edit("ttsModel", setTtsModel)}
                  placeholder={DEFAULT_COMPATIBLE_TTS_MODEL}
                  placeholderTextColor={native.tertiaryLabel}
                  style={styles.input}
                />
                <Text style={styles.fieldLabel}>{t("Transcription model")}</Text>
                <TextInput
                  accessibilityLabel={t("Transcription model")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={sttModel}
                  onChangeText={edit("sttModel", setSttModel)}
                  placeholder={DEFAULT_COMPATIBLE_STT_MODEL}
                  placeholderTextColor={native.tertiaryLabel}
                  style={styles.input}
                />
              </>
            ) : null}
            {keyless && credential ? null : (
              <NativeActionButton
                disabled={pending !== null || !canConnect}
                label={
                  credential && selfHosted
                    ? t("Reconnect")
                    : credential
                      ? t("Replace key")
                      : t("Connect")
                }
                onPress={() => void connect()}
              />
            )}
            {credential && scope === "account" ? (
              <NativeActionButton
                disabled={pending !== null}
                label={pending === "disconnect" ? t("Disconnecting…") : t("Disconnect")}
                onPress={() => void disconnect()}
                prominence="destructive"
              />
            ) : null}
            {credential && selected.id === "fish-audio" ? (
              <>
                <Text style={styles.fieldLabel}>{t("Speech model")}</Text>
                <TextInput
                  accessibilityLabel={t("Speech model")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={pending === null}
                  value={speechModel}
                  onChangeText={edit("speechModel", setSpeechModel)}
                  onBlur={() => void saveSpeechModel()}
                  onSubmitEditing={() => void saveSpeechModel()}
                  placeholder={t("Optional")}
                  placeholderTextColor={native.tertiaryLabel}
                  style={styles.input}
                />
              </>
            ) : null}
            {voices.length ? (
              <View style={[styles.group, styles.voices]}>
                {voices.map((voice, index) => (
                  <Pressable
                    key={voice.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: voiceId === voice.id }}
                    disabled={pending !== null}
                    onPress={() => void chooseVoice(voice.id)}
                    style={({ pressed }) => [
                      styles.groupRow,
                      index > 0 && styles.groupDivider,
                      pending !== null && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.voiceLabel}>{voice.label}</Text>
                    {voiceId === voice.id ? <Checkmark /> : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
        ) : null}
        {deviceSettings && (deviceVoice || status?.ready) ? (
          <NativeActionButton
            disabled={pending !== null}
            label={t("Hear a sample")}
            onPress={() => void testVoice()}
          />
        ) : null}
        {deviceSettings ? (
          <View style={styles.group}>
            <View style={styles.groupRow}>
              <View style={styles.rowCopy}>
                <Text style={styles.cardTitle}>{t("Call sounds")}</Text>
              </View>
              <NativeSwitch
                accessibilityLabel={t("Call sounds")}
                value={callSounds === true}
                disabled={callSounds === null}
                onValueChange={(next) => void toggleCallSounds(next)}
              />
            </View>
            <View style={[styles.groupRow, styles.groupDivider]}>
              <View style={styles.rowCopy}>
                <Text style={styles.cardTitle}>{t("Waiting sound")}</Text>
              </View>
              <NativeSwitch
                accessibilityLabel={t("Waiting sound")}
                value={waitSound === true}
                disabled={waitSound === null}
                onValueChange={(next) => void toggleWaitSound(next)}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createVoiceStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 10 },
    error: { color: tokens.destructive, marginBottom: 8 },
    group: { borderRadius: 14, backgroundColor: native.fill, overflow: "hidden" },
    groupRow: {
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    groupDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.separator,
    },
    rowCopy: { flex: 1 },
    cardTitle: { color: native.label, fontSize: 16 },
    fieldLabel: { color: native.label, marginTop: 16 },
    input: {
      marginTop: 8,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
    voices: { marginTop: 12 },
    voiceLabel: { flex: 1, color: native.label, fontSize: 16 },
  });
}
