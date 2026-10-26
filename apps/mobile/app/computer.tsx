import type { ComputerMode, ComputerReleaseReason } from "@rakazo/contracts";
import type { ScreenPageState } from "@rakazo/core";
import {
  createScreenReconnect,
  displayName,
  isRetryableError,
  SCREEN_RECONNECT_DELAY_MS,
  screenProbeUrl,
  waitForScreenPage,
} from "@rakazo/core";
import { useLocalSearchParams, useNavigation } from "expo-router";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView,
} from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { ComputerKeyboardBar } from "../components/computer-keyboard-bar";
import { ComputerMaintenanceActions } from "../components/computer-maintenance-actions";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { GlassIconButton } from "../components/glass-icon-button";
import { NativeActionButton } from "../components/native-action-button";
import { currentApiBase, rpc } from "../lib/api";
import { useAppForeground } from "../lib/app-foreground";
import type { ComputerStatus } from "../lib/computer";
import {
  COMPUTER_HEARTBEAT_MS,
  COMPUTER_LIFECYCLE_TIMEOUT_MS,
  computerLabel,
  controlLabel,
  embeddableScreenUrl,
  fromScreenPage,
  isProxiedScreenPage,
  nextLoadedScreenUrl,
  previewPlaceholder,
  readScreenUrl,
  retainScreenSource,
  SCREEN_URL_OPEN_ATTEMPTS,
  screenPageState,
  screenPageStatus,
  screenStreamKey,
} from "../lib/computer";
import type { ComputerKeyboardCommand } from "../lib/computer-keyboard";
import {
  computerKeyboardReadyProbe,
  computerKeyboardScript,
  createComputerKeyboardBridge,
  isComputerKeyboardReadyMessage,
  NATIVE_COMPUTER_KEYBOARD_BOOT,
} from "../lib/computer-keyboard";
import { createComputerRefresh } from "../lib/computer-refresh";
import { tabletopLayout } from "../lib/fold-layout";
import { useFoldRegions } from "../lib/fold-regions";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { useSideInsets } from "../lib/side-insets";
import { stacksAtTextScale } from "../lib/text-scale";
import { computerBootErrorDetail, errorText } from "../lib/user-error";

export default function Computer() {
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const navigation = useNavigation();
  const windowSize = useWindowDimensions();
  const stacked = stacksAtTextScale(windowSize.fontScale);
  const folds = useFoldRegions();
  const { botId, name: nameParam } = useLocalSearchParams<{ botId?: string; name?: string }>();
  const name = displayName(nameParam, t("Bot"));
  const foreground = useAppForeground();
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [screenOriginError, setScreenOriginError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyBotId, setReadyBotId] = useState<string | null>(null);
  const [bootingCount, setBootingCount] = useState(0);
  const [switchingCount, setSwitchingCount] = useState(0);
  const booting = bootingCount > 0;
  const [bootFailed, setBootFailed] = useState(false);
  const switching = switchingCount > 0;
  const [computerOpen, setComputerOpen] = useState(false);
  // The keyboard closes on the Release tap, not when the server answers.
  const [releasing, setReleasing] = useState(false);
  const autoBooted = useRef<string | null>(null);
  const screenWebViewRef = useRef<WebView>(null);
  const keyboardGate = useRef({
    key: "",
    session: 0,
    bridge: createComputerKeyboardBridge(),
  });
  const heldScreenUrl = useRef<string | null>(null);
  // Bumped to load the screen page again after the app returns from the background or the
  // WebView loses its renderer; either can leave the stream black until it reconnects.
  const [screenReload, setScreenReload] = useState(0);

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl, currentApiBase());
  useEffect(() => setScreenError(null), [embeddedScreenUrl]);

  const hasControl = computer?.controlHolder === "user" && computer.controlBotId === botId;
  // Propped open like a laptop, the desktop stays above the fold and the keys go below it.
  const tabletop = hasControl ? tabletopLayout(windowSize.width, windowSize.height, folds) : null;
  const screenVisible =
    computerOpen && computer?.state === "running" && Boolean(embeddedScreenUrl) && !screenError;
  const loadedScreenUrl = nextLoadedScreenUrl(
    heldScreenUrl.current,
    embeddedScreenUrl,
    screenVisible,
  );
  heldScreenUrl.current = loadedScreenUrl;
  // The gate follows the page the WebView actually loaded. A capability refresh that
  // does not reload that page must not open a session the bridge will never acknowledge.
  const keyboardSurfaceKey = `${computerOpen}:${hasControl}:${screenReload}:${loadedScreenUrl ?? ""}`;
  if (keyboardGate.current.key !== keyboardSurfaceKey) {
    keyboardGate.current = {
      key: keyboardSurfaceKey,
      session: keyboardGate.current.session + 1,
      bridge: createComputerKeyboardBridge(),
    };
  }
  const keyboardSession = String(keyboardGate.current.session);

  useEffect(() => {
    if (!computerOpen || !hasControl || !loadedScreenUrl) return;
    const gate = keyboardGate.current;
    if (gate.bridge.isReady()) return;
    const webView = screenWebViewRef.current;
    if (!webView) return;
    webView.injectJavaScript(computerKeyboardReadyProbe(String(gate.session)));
  }, [computerOpen, hasControl, loadedScreenUrl, embeddedScreenUrl, keyboardSession]);

  function injectKeyboardCommands(commands: ComputerKeyboardCommand[]) {
    const webView = screenWebViewRef.current;
    if (!webView) return;
    for (const command of commands) webView.injectJavaScript(computerKeyboardScript(command));
  }

  const label = computerLabel(computer?.mode, name);

  useLayoutEffect(() => {
    navigation.setOptions({ title: label });
  }, [label, navigation]);

  const refreshController = useMemo(
    () =>
      createComputerRefresh({
        readStatus: () => rpc("computer/status", { botId: botId ?? "" }),
        readScreen: (attempts) =>
          readScreenUrl(() => rpc("computer/screenUrl", { botId: botId ?? "" }), {
            attempts,
          }),
        onStatus: (status) => {
          setComputer(status);
          // Another client may have started it since this one failed.
          if (status.state === "running") setBootFailed(false);
        },
        onScreen: setScreenUrl,
        onReady: () => setReadyBotId(botId ?? null),
        onInitialError: (err) => setError(errorText(err)),
      }),
    [botId],
  );
  const refresh = refreshController.refresh;
  const refreshAfterMaintenance = useCallback(async () => {
    await refresh();
  }, [refresh]);

  useEffect(() => {
    setComputer(null);
    setScreenUrl(null);
    setScreenError(null);
    setScreenOriginError(false);
    setError(null);
    setReadyBotId(null);
    setBootingCount(0);
    setBootFailed(false);
    setSwitchingCount(0);
    setComputerOpen(false);
    autoBooted.current = null;
    if (botId) refreshController.start();
    return () => refreshController.dispose();
  }, [botId, refreshController]);

  // The computer status poll and the live WebView are expensive; neither should
  // run while the app is in the background.
  useEffect(() => {
    if (!botId) return;
    if (foreground) refreshController.resume();
    else refreshController.pause();
  }, [botId, foreground, refreshController]);

  async function bootComputer({
    takeControl,
    showProgress,
    force = false,
  }: {
    takeControl: boolean;
    showProgress: boolean;
    force?: boolean;
  }) {
    if (!botId || !refreshController.isActive()) return false;
    const action = refreshController.beginAction();
    const needsBoot = force || computer?.state !== "running" || !screenUrl;
    let starting = needsBoot;
    const showBooting = showProgress && needsBoot;
    if (showBooting) {
      setBootingCount((count) => count + 1);
      setError(null);
    }
    setBootFailed(false);
    try {
      if (needsBoot) {
        const answered = await rpc(
          "computer/boot",
          { botId },
          { timeoutMs: COMPUTER_LIFECYCLE_TIMEOUT_MS },
        ).then(
          () => true,
          (err: unknown) => {
            // The server keeps booting after the client stops waiting; the status poll takes over.
            if (err instanceof Error && err.name === "TimeoutError") return false;
            throw err;
          },
        );
        if (!answered) return false;
      }
      starting = false;
      if (!action.isActive()) return false;
      if (takeControl) await rpc("computer/takeover", { botId });
      if (!action.isActive()) return false;
      await action.refresh({ screenAttempts: SCREEN_URL_OPEN_ATTEMPTS });
      if (!action.isActive()) return false;
      setError(null);
      return true;
    } catch (err) {
      if (!action.isActive()) return false;
      setError(
        starting
          ? computerBootErrorDetail(err)
          : err instanceof Error && err.name === "TimeoutError"
            ? t("Request timed out")
            : errorText(err, t("Could not open computer")),
      );
      setBootFailed(starting);
      throw err;
    } finally {
      if (action.isActive() && showBooting) setBootingCount((count) => count - 1);
      action.finish();
    }
  }

  useEffect(() => {
    if (!botId || readyBotId !== botId || switching) return;
    if (computer?.state === "booting" || computer?.state === "suspended") return;
    if (autoBooted.current === botId) return;
    autoBooted.current = botId;
    void bootComputer({
      takeControl: false,
      showProgress: computer?.state !== "running",
      force: true,
    }).catch(() => undefined);
  }, [readyBotId, botId, computer?.state, switching]);

  const reloadScreen = useCallback(async () => {
    await refresh().catch(() => undefined);
    heldScreenUrl.current = null;
    setScreenError(null);
    setScreenReload((count) => count + 1);
  }, [refresh]);

  // A screen that drops after connecting loads again by itself now and then; the load goes
  // through the screen's full authorization, so a revoked one stays closed.
  const screenReconnect = useRef(createScreenReconnect());
  const screenReconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const screenReconnectWait = useRef<AbortController | null>(null);
  const currentScreenUrl = useRef<string | null>(null);
  currentScreenUrl.current = loadedScreenUrl ?? embeddedScreenUrl;
  const onScreenState = useCallback(
    (state: ScreenPageState) => {
      const next = screenReconnect.current.report(state);
      if (next !== "reconnect") {
        // A drop that won't reconnect by itself shows why, with Retry.
        const failed = next === "error";
        setScreenOriginError(failed);
        setScreenError(
          !failed
            ? null
            : state === "failed"
              ? t("Could not connect to the computer screen")
              : t("The screen connection closed."),
        );
        return;
      }
      clearTimeout(screenReconnectTimer.current);
      screenReconnectWait.current?.abort();
      const wait = new AbortController();
      screenReconnectWait.current = wait;
      const url = currentScreenUrl.current;
      screenReconnectTimer.current = setTimeout(() => {
        // Wait out an API that can't be reached, so the one reconnect isn't spent on it; the
        // reload then shows whatever the page answers.
        // Only the proxy answers probes; another screen is loaded again straight away.
        const probe = url && isProxiedScreenPage(url) ? screenProbeUrl(url) : null;
        void waitForScreenPage(
          async (signal) => (probe ? screenPageStatus(probe, fetch, signal) : 200),
          { signal: wait.signal },
        ).then((outcome) => {
          if (outcome !== "cancelled") void reloadScreen();
        });
      }, SCREEN_RECONNECT_DELAY_MS);
    },
    [reloadScreen, t],
  );
  const onScreenLoadStart = useCallback(() => screenReconnect.current.loaded(), []);
  // Closing the screen, leaving the app or a new screen URL (taking or releasing control)
  // cancels a pending reconnect.
  useEffect(
    () => () => {
      screenReconnectWait.current?.abort();
      clearTimeout(screenReconnectTimer.current);
    },
    // A renewed link for the same screen keeps the page and the pending reconnect.
    [computerOpen, foreground, embeddedScreenUrl ? screenStreamKey(embeddedScreenUrl) : null],
  );

  useEffect(() => {
    if (!computerOpen) return;
    let backgrounded = false;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") backgrounded = true;
      if (state !== "active" || !backgrounded) return;
      backgrounded = false;
      void reloadScreen();
    });
    return () => subscription.remove();
  }, [computerOpen, reloadScreen]);

  useEffect(() => {
    if (!botId || !foreground || computer?.state !== "running") return;
    // A refused heartbeat (403, 404, 426...) stops until the computer's state changes.
    const ping = () =>
      void rpc("computer/heartbeat", { botId }).catch((error: unknown) => {
        if (!isRetryableError(error)) clearInterval(timer);
      });
    const timer = setInterval(ping, COMPUTER_HEARTBEAT_MS);
    ping();
    return () => clearInterval(timer);
  }, [botId, computer?.state, foreground]);

  /** Open the full window. Only an explicit Take control asks for the lease. */
  async function openComputer({ takeControl }: { takeControl: boolean }) {
    if (!botId) return;
    const needsTakeover = takeControl && !hasControl;
    try {
      const opened = await bootComputer({
        takeControl: needsTakeover,
        showProgress: needsTakeover || computer?.state !== "running",
        force: computer?.state !== "running",
      });
      if (!opened || !refreshController.isActive()) return;
      setComputerOpen(true);
      setScreenError(null);
    } catch {
      // error already set
    }
  }

  async function releaseComputer(reason?: ComputerReleaseReason) {
    if (!botId || !refreshController.isActive()) return;
    const action = refreshController.beginAction();
    setReleasing(true);
    try {
      await rpc("computer/release", { botId, reason });
      if (!action.isActive()) return;
      setComputerOpen(false);
      await action.refresh().catch(() => undefined);
    } catch {
      if (action.isActive()) {
        setScreenOriginError(false);
        setScreenError(t("Could not continue"));
      }
    } finally {
      setReleasing(false);
      action.finish();
    }
  }

  async function setComputerMode(mode: ComputerMode) {
    if (!botId || !refreshController.isActive() || mode === computer?.mode) return;
    const action = refreshController.beginAction();
    setSwitchingCount((count) => count + 1);
    setError(null);
    try {
      if (hasControl) {
        await rpc("computer/release", {
          botId,
          reason: computer?.takeoverRequested ? "skipped" : undefined,
        });
      }
      if (!action.isActive()) return;
      await rpc("bots/setComputer", { botId, mode }, { timeoutMs: COMPUTER_LIFECYCLE_TIMEOUT_MS });
      if (!action.isActive()) return;
      setComputer(null);
      setScreenUrl(null);
      autoBooted.current = null;
      await action.refresh();
    } catch (err) {
      if (!action.isActive()) return;
      setError(errorText(err, t("Could not switch computer")));
    } finally {
      if (action.isActive()) setSwitchingCount((count) => count - 1);
      action.finish();
    }
  }

  const keyboardBar = hasControl ? (
    <ComputerKeyboardBar
      active={computerOpen && !releasing}
      onCommand={(command) => {
        injectKeyboardCommands(keyboardGate.current.bridge.push(command));
      }}
    />
  ) : null;
  const placeholder =
    screenError ?? previewPlaceholder(computer?.state, booting, name, computer?.mode);
  // Booting shows in the preview; the header and Back stay, and leaving lets the boot finish.
  const bootPending = booting || computer?.state === "booting";
  const canRetry = !bootPending && (bootFailed || computer?.state === "error");
  const screenRetry = computer?.state === "running" && screenOriginError && Boolean(screenError);
  const retryScreenAction = screenRetry ? (
    <NativeActionButton
      style={{ marginBottom: 16 }}
      label={t("Retry screen")}
      prominence="primary"
      size="default"
      onPress={() => void reloadScreen()}
    />
  ) : null;

  return (
    // The full window's Modal is a child of this scroll view. A tap there, on Close or on the
    // native keyboard bar, must never just dismiss the computer keyboard; only the bar closes it.
    <ScrollView
      style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
      contentContainerStyle={{ padding: 24 }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="always"
    >
      {canRetry && computer?.state !== "running" ? (
        <View style={{ gap: 8, marginBottom: 16 }}>
          <Text style={{ color: tokens.destructive, fontSize: 17, fontWeight: "600" }}>
            {t("Couldn't start the computer")}
          </Text>
          <Text style={{ color: tokens.mutedForeground }}>
            {t("Something went wrong while it was starting. Try again in a moment.")}
          </Text>
          {error ? (
            <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{error}</Text>
          ) : null}
        </View>
      ) : error || canRetry ? (
        <Text style={{ color: tokens.mutedForeground, marginBottom: 12 }}>
          {error ?? t("Something went wrong while it was starting. Try again in a moment.")}
        </Text>
      ) : null}
      {retryScreenAction}
      {canRetry ? (
        <NativeActionButton
          label={t("Try again")}
          prominence="primary"
          size="default"
          style={{ marginBottom: 16 }}
          onPress={() =>
            void bootComputer({ takeControl: false, showProgress: true, force: true }).catch(
              () => undefined,
            )
          }
        />
      ) : null}
      <View
        style={{
          height: 360,
          minHeight: 220,
          borderRadius: 14,
          overflow: "hidden",
          backgroundColor: tokens.card,
        }}
      >
        {computerOpen ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: tokens.mutedForeground }}>{t("Open in full window")}</Text>
          </View>
        ) : foreground && computer?.state === "running" && embeddedScreenUrl && !screenError ? (
          <ScreenWebView
            key={screenReload}
            url={embeddedScreenUrl}
            interactive={false}
            onScreenState={onScreenState}
            onLoadStart={onScreenLoadStart}
            onRendererLost={() => void reloadScreen()}
            onError={() => {
              refreshController.invalidateScreen();
              setScreenOriginError(true);
              setScreenError(
                t("Could not load the desktop. This device cannot reach the screen URL."),
              );
            }}
          />
        ) : (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 16,
            }}
          >
            {bootPending ? <ActivityIndicator size="large" color={tokens.mutedForeground} /> : null}
            <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
              {placeholder}
            </Text>
          </View>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={bootPending ? placeholder : t("Open computer")}
          accessibilityState={{ disabled: bootPending, busy: bootPending }}
          disabled={bootPending}
          onPress={() => void openComputer({ takeControl: false })}
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
        />
      </View>
      <View
        style={{
          marginTop: 16,
          flexDirection: stacked ? "column" : "row",
          alignItems: stacked ? "flex-start" : "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text
          style={{
            color: tokens.mutedForeground,
            ...(stacked ? { alignSelf: "stretch" } : { flex: 1 }),
          }}
        >
          {controlLabel(computer, name, botId)}
        </Text>
        {hasControl ? (
          <ComputerReleaseActions
            takeoverRequested={computer?.takeoverRequested ?? false}
            onRelease={releaseComputer}
          />
        ) : (
          <NativeActionButton
            label={t("Take control")}
            prominence="secondary"
            disabled={bootPending}
            style={{ alignSelf: "center" }}
            onPress={() => void openComputer({ takeControl: true })}
          />
        )}
      </View>
      {computer ? (
        <ComputerMaintenanceActions
          botId={botId ?? ""}
          computer={computer}
          onChanged={refreshAfterMaintenance}
        />
      ) : null}
      <ComputerModePicker
        // Restacking the row above leaves the native picker at its old measured height; remount it.
        key={stacked ? "stacked" : "row"}
        value={computer?.mode}
        disabled={switching || bootPending}
        onChange={(mode) => void setComputerMode(mode)}
      />

      <Modal
        visible={computerOpen}
        animationType="fade"
        presentationStyle="fullScreen"
        supportedOrientations={["portrait", "landscape-left", "landscape-right"]}
        onRequestClose={() => setComputerOpen(false)}
      >
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <KeyboardAvoidingView
            behavior="height"
            enabled={!tabletop}
            style={{ flex: 1, backgroundColor: tokens.background }}
          >
            <SafeAreaView
              edges={["top", "left", "right"]}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                borderBottomWidth: iosAtLeast(26) ? 0 : 1,
                borderBottomColor: tokens.border,
                paddingHorizontal: 14,
                paddingVertical: 4,
              }}
            >
              <View
                style={{
                  flex: 1,
                  minWidth: 0,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    flexShrink: 1,
                    color: tokens.foreground,
                    fontSize: 15.5,
                    fontWeight: "500",
                  }}
                >
                  {label}
                </Text>
                {hasControl ? (
                  <View
                    style={{
                      borderRadius: 999,
                      backgroundColor: tokens.muted,
                      paddingHorizontal: 9,
                      paddingVertical: 3,
                    }}
                  >
                    <Text numberOfLines={1} style={{ color: tokens.success, fontSize: 12 }}>
                      {t("You have control")}
                    </Text>
                  </View>
                ) : null}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                {hasControl ? (
                  <ComputerReleaseActions
                    takeoverRequested={computer?.takeoverRequested ?? false}
                    onRelease={releaseComputer}
                  />
                ) : (
                  <NativeActionButton
                    label={t("Take control")}
                    prominence="secondary"
                    fill={false}
                    style={{ alignSelf: "center" }}
                    onPress={() =>
                      void bootComputer({ takeControl: true, showProgress: false }).catch(
                        () => undefined,
                      )
                    }
                  />
                )}
                <GlassIconButton
                  accessibilityLabel={t("Close computer")}
                  onPress={() => setComputerOpen(false)}
                  ios="xmark"
                  android="close"
                  size={36}
                  iconSize={16}
                />
              </View>
            </SafeAreaView>
            <View style={{ flex: 1, backgroundColor: tokens.card }}>
              {foreground && loadedScreenUrl ? (
                <ScreenWebView
                  key={screenReload}
                  url={loadedScreenUrl}
                  interactive={hasControl}
                  nativeKeyboard={hasControl}
                  keyboardSession={keyboardSession}
                  webViewRef={screenWebViewRef}
                  onKeyboardMessage={(data) => {
                    const gate = keyboardGate.current;
                    if (!isComputerKeyboardReadyMessage(data, String(gate.session))) return;
                    injectKeyboardCommands(gate.bridge.ready());
                  }}
                  onScreenState={onScreenState}
                  onLoadStart={onScreenLoadStart}
                  onRendererLost={() => void reloadScreen()}
                  onError={() => {
                    refreshController.invalidateScreen();
                    setScreenOriginError(true);
                    setScreenError(
                      t("Could not load the desktop. This device cannot reach the screen URL."),
                    );
                  }}
                />
              ) : (
                <View
                  style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}
                >
                  <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
                    {placeholder}
                  </Text>
                  {retryScreenAction}
                </View>
              )}
            </View>
            {tabletop ? (
              // A fixed lower half, so the keyboard lifts the bar without pushing the desktop.
              <View style={{ height: windowSize.height - tabletop.top, paddingTop: tabletop.gap }}>
                <KeyboardAvoidingView
                  behavior="height"
                  style={{ flex: 1, justifyContent: "flex-end" }}
                >
                  {keyboardBar}
                </KeyboardAvoidingView>
              </View>
            ) : (
              keyboardBar
            )}
          </KeyboardAvoidingView>
        </SafeAreaProvider>
      </Modal>
    </ScrollView>
  );
}

function ComputerReleaseActions({
  takeoverRequested,
  onRelease,
}: {
  takeoverRequested: boolean;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
}) {
  const { t } = useI18n();
  const actions: Array<{ label: string; reason?: ComputerReleaseReason; primary?: boolean }> =
    takeoverRequested
      ? [
          { label: t("Skip"), reason: "skipped" },
          { label: t("I’m done"), reason: "done", primary: true },
        ]
      : [{ label: t("Release") }];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {actions.map((action) => (
        <NativeActionButton
          key={action.label}
          label={action.label}
          prominence={action.primary ? "primary" : "secondary"}
          fill={false}
          style={{ alignSelf: "center" }}
          onPress={() => void onRelease(action.reason)}
        />
      ))}
    </View>
  );
}

function ScreenWebView({
  url,
  interactive,
  nativeKeyboard = false,
  keyboardSession,
  webViewRef,
  onKeyboardMessage,
  onScreenState,
  onLoadStart,
  onRendererLost,
  onError,
}: {
  url: string;
  interactive: boolean;
  nativeKeyboard?: boolean;
  keyboardSession?: string;
  webViewRef?: RefObject<WebView | null>;
  onKeyboardMessage?: (data: string) => void;
  onScreenState?: (state: ScreenPageState) => void;
  onLoadStart?: () => void;
  onRendererLost?: () => void;
  onError: () => void;
}) {
  const tokens = useMobileTokens();
  const sourceUrl = useRef(url);
  sourceUrl.current = retainScreenSource(sourceUrl.current, url);
  const loadedSource = sourceUrl.current;
  const reportStarted = useRef(false);
  const reportCallback = useRef(onScreenState);
  reportCallback.current = onScreenState;
  useEffect(() => {
    reportStarted.current = false;
    // Only proxy pages report their state; one that never starts shows as failed.
    if (!isProxiedScreenPage(loadedSource)) return;
    const timer = setTimeout(() => {
      if (!reportStarted.current) reportCallback.current?.("failed");
    }, 15_000);
    return () => clearTimeout(timer);
  }, [loadedSource, nativeKeyboard]);
  return (
    <WebView
      ref={webViewRef}
      // Reload when control enables the native keyboard. The boot script only
      // runs on load, and a view-only page never attaches the key bridge.
      key={`${nativeKeyboard ? "keys" : "view"}:${sourceUrl.current}`}
      source={{ uri: sourceUrl.current }}
      injectedJavaScriptBeforeContentLoaded={
        nativeKeyboard ? NATIVE_COMPUTER_KEYBOARD_BOOT : undefined
      }
      injectedJavaScript={
        nativeKeyboard && keyboardSession ? computerKeyboardReadyProbe(keyboardSession) : undefined
      }
      onMessage={(event) => {
        const state = fromScreenPage(event.nativeEvent.url, sourceUrl.current)
          ? screenPageState(event.nativeEvent.data)
          : null;
        if (state) {
          if (state !== "loading") reportStarted.current = true;
          onScreenState?.(state);
        } else if (nativeKeyboard) onKeyboardMessage?.(event.nativeEvent.data);
      }}
      onLoadStart={onLoadStart}
      style={{ flex: 1, backgroundColor: tokens.background }}
      pointerEvents={interactive ? "auto" : "none"}
      // A view-only screen is a picture: keep its page, including the hidden keyboard field,
      // out of VoiceOver and TalkBack.
      accessibilityElementsHidden={!interactive}
      importantForAccessibility={interactive ? "auto" : "no-hide-descendants"}
      javaScriptEnabled
      domStorageEnabled
      keyboardDisplayRequiresUserAction={false}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      originWhitelist={["*"]}
      mixedContentMode="always"
      setSupportMultipleWindows={false}
      scrollEnabled={false}
      overScrollMode="never"
      onError={onError}
      onHttpError={onError}
      onRenderProcessGone={onRendererLost}
      onContentProcessDidTerminate={onRendererLost}
    />
  );
}
