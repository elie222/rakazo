import type { ComputerMode, ComputerReleaseReason } from "@rakazo/contracts";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView,
} from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { ComputerMaintenanceActions } from "../components/computer-maintenance-actions";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { NativeSymbol } from "../components/native-symbol";
import { currentApiBase, rpc } from "../lib/api";
import {
  COMPUTER_HEARTBEAT_MS,
  type ComputerStatus,
  computerLabel,
  controlLabel,
  embeddableScreenUrl,
  previewPlaceholder,
  readScreenUrl,
  SCREEN_URL_OPEN_ATTEMPTS,
} from "../lib/computer";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export default function Computer() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const navigation = useNavigation();
  const { botId, name: nameParam } = useLocalSearchParams<{ botId?: string; name?: string }>();
  const name = nameParam || t("Bot");
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [booting, setBooting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  const autoBooted = useRef<string | null>(null);

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl, currentApiBase());
  useEffect(() => setScreenError(null), [embeddedScreenUrl]);

  const hasControl = computer?.controlHolder === "user" && computer.controlBotId === botId;
  const label = computerLabel(computer?.mode, name);

  useLayoutEffect(() => {
    navigation.setOptions({ title: label });
  }, [label, navigation]);

  async function refreshScreen(attempts: number) {
    if (!botId) return;
    try {
      setScreenUrl(
        await readScreenUrl(() => rpc<{ url: string | null }>("computer/screenUrl", { botId }), {
          attempts,
        }),
      );
    } catch {
      // Keep the last known URL. Cold boots often fail this RPC once, then succeed.
    }
  }

  async function refresh(options?: { screenAttempts?: number }) {
    if (!botId) return;
    const status = await rpc<ComputerStatus>("computer/status", { botId });
    setComputer(status);
    await refreshScreen(options?.screenAttempts ?? 1);
    setReady(true);
    return status;
  }

  useEffect(() => {
    void refresh().catch((err: Error) => {
      setError(err.message);
      setReady(true);
    });
    const timer = setInterval(() => void refresh().catch(() => undefined), 2000);
    return () => clearInterval(timer);
  }, [botId]);

  async function bootComputer({
    takeControl,
    overlay,
    force = false,
  }: {
    takeControl: boolean;
    overlay: boolean;
    force?: boolean;
  }) {
    if (!botId) return;
    const needsBoot = force || computer?.state !== "running" || !screenUrl;
    if (overlay && needsBoot) setBooting(true);
    try {
      if (needsBoot) await rpc("computer/boot", { botId });
      if (takeControl) await rpc("computer/takeover", { botId });
      await refresh({ screenAttempts: SCREEN_URL_OPEN_ATTEMPTS });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not open computer"));
      throw err;
    } finally {
      setBooting(false);
    }
  }

  useEffect(() => {
    if (!ready || !botId) return;
    if (computer?.state === "booting" || computer?.state === "suspended") return;
    if (autoBooted.current === botId) return;
    autoBooted.current = botId;
    void bootComputer({
      takeControl: false,
      overlay: computer?.state !== "running",
      force: true,
    }).catch(() => undefined);
  }, [ready, botId, computer?.state]);

  useEffect(() => {
    if (!botId || computer?.state !== "running") return;
    const ping = () => void rpc("computer/heartbeat", { botId }).catch(() => undefined);
    ping();
    const timer = setInterval(ping, COMPUTER_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [botId, computer?.state]);

  async function openComputer() {
    if (!botId) return;
    const needsTakeover = !(computer?.controlHolder === "user" && computer.controlBotId === botId);
    try {
      await bootComputer({
        takeControl: needsTakeover,
        overlay: needsTakeover || computer?.state !== "running",
        force: computer?.state !== "running",
      });
      setComputerOpen(true);
      setScreenError(null);
    } catch {
      // error already set
    }
  }

  async function releaseComputer(reason?: ComputerReleaseReason) {
    if (!botId) return;
    await rpc("computer/release", { botId, reason }).catch(() => undefined);
    setComputerOpen(false);
    await refresh().catch(() => undefined);
  }

  async function setComputerMode(mode: ComputerMode) {
    if (!botId || mode === computer?.mode) return;
    setSwitching(true);
    setError(null);
    try {
      if (hasControl) {
        await rpc("computer/release", {
          botId,
          reason: computer?.takeoverRequested ? "skipped" : undefined,
        });
      }
      await rpc("bots/setComputer", { botId, mode });
      setComputer(null);
      setScreenUrl(null);
      autoBooted.current = null;
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not switch computer"));
    } finally {
      setSwitching(false);
    }
  }

  const placeholder =
    screenError ?? previewPlaceholder(computer?.state, booting, name, computer?.mode);

  return (
    <View style={{ flex: 1, backgroundColor: tokens.background, padding: 24 }}>
      {error ? (
        <Text style={{ color: tokens.mutedForeground, marginBottom: 12 }}>{error}</Text>
      ) : null}
      <View
        style={{
          flex: 1,
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
        ) : computer?.state === "running" && embeddedScreenUrl && !screenError ? (
          <ScreenWebView
            url={embeddedScreenUrl}
            interactive={false}
            onError={() =>
              setScreenError(
                t("Could not load the desktop. This device cannot reach the screen URL."),
              )
            }
          />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
            <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
              {placeholder}
            </Text>
          </View>
        )}
        <Pressable
          accessibilityLabel={t("Open computer")}
          onPress={() => void openComputer()}
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
        />
      </View>
      <View
        style={{
          marginTop: 16,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text style={{ color: tokens.mutedForeground, flex: 1 }}>
          {controlLabel(computer, name, botId)}
        </Text>
        {hasControl ? (
          <ComputerReleaseActions
            takeoverRequested={computer?.takeoverRequested ?? false}
            onRelease={releaseComputer}
          />
        ) : (
          <Pressable
            onPress={() => void openComputer()}
            style={{
              backgroundColor: tokens.muted,
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderRadius: 12,
            }}
          >
            <Text style={{ color: tokens.foreground }}>{t("Take control")}</Text>
          </Pressable>
        )}
      </View>
      {computer?.state === "error" ||
      computer?.state === "stopped" ||
      (computer?.state === "running" && !embeddedScreenUrl) ? (
        <ComputerMaintenanceActions
          botId={botId ?? ""}
          computer={computer}
          onChanged={async () => {
            await refresh();
          }}
        />
      ) : null}
      <ComputerModePicker
        value={computer?.mode}
        disabled={switching}
        onChange={(mode) => void setComputerMode(mode)}
      />

      <Modal
        visible={booting || computerOpen}
        animationType="fade"
        presentationStyle="fullScreen"
        onRequestClose={() => {
          if (!booting) setComputerOpen(false);
        }}
      >
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          {booting ? (
            <SafeAreaView
              edges={["top", "left", "right"]}
              style={{
                flex: 1,
                backgroundColor: tokens.background,
                alignItems: "center",
                justifyContent: "center",
                gap: 22,
                padding: 24,
              }}
            >
              <Text
                style={{
                  color: tokens.foreground,
                  fontSize: 19,
                  fontWeight: "500",
                  textAlign: "center",
                }}
              >
                {t("Booting {label}", { label })}
              </Text>
              <View
                style={{
                  height: 5,
                  width: "70%",
                  maxWidth: 420,
                  overflow: "hidden",
                  borderRadius: 999,
                  backgroundColor: tokens.muted,
                }}
              >
                <View
                  style={{
                    height: "100%",
                    width: "66%",
                    borderRadius: 999,
                    backgroundColor: tokens.primary,
                  }}
                />
              </View>
            </SafeAreaView>
          ) : (
            <View style={{ flex: 1, backgroundColor: tokens.background }}>
              <SafeAreaView
                edges={["top", "left", "right"]}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: tokens.border,
                  paddingHorizontal: 18,
                  paddingVertical: 14,
                }}
              >
                <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
                  <Text
                    numberOfLines={1}
                    style={{ color: tokens.foreground, fontSize: 15.5, fontWeight: "500" }}
                  >
                    {label}
                  </Text>
                  {hasControl ? (
                    <View
                      style={{
                        alignSelf: "flex-start",
                        borderRadius: 999,
                        backgroundColor: tokens.muted,
                        paddingHorizontal: 11,
                        paddingVertical: 4,
                      }}
                    >
                      <Text style={{ color: tokens.success, fontSize: 13 }}>
                        {t("You have control")}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  {hasControl ? (
                    <ComputerReleaseActions
                      takeoverRequested={computer?.takeoverRequested ?? false}
                      onRelease={releaseComputer}
                    />
                  ) : (
                    <Pressable
                      onPress={() =>
                        void bootComputer({ takeControl: true, overlay: false }).catch(
                          () => undefined,
                        )
                      }
                      hitSlop={8}
                      style={{
                        borderWidth: 1,
                        borderColor: tokens.border,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 10,
                        minHeight: 44,
                        justifyContent: "center",
                      }}
                    >
                      <Text style={{ color: tokens.foreground }}>{t("Take control")}</Text>
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityLabel={t("Close computer")}
                    hitSlop={8}
                    onPress={() => setComputerOpen(false)}
                    style={{
                      minWidth: 44,
                      minHeight: 44,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <NativeSymbol
                      ios="xmark"
                      android="close"
                      size={16}
                      color={tokens.mutedForeground}
                    />
                  </Pressable>
                </View>
              </SafeAreaView>
              <View style={{ flex: 1, backgroundColor: tokens.card }}>
                {computer?.state === "running" && embeddedScreenUrl && !screenError ? (
                  <ScreenWebView
                    url={embeddedScreenUrl}
                    interactive={hasControl}
                    onError={() =>
                      setScreenError(
                        t("Could not load the desktop. This device cannot reach the screen URL."),
                      )
                    }
                  />
                ) : (
                  <View
                    style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}
                  >
                    <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
                      {placeholder}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          )}
        </SafeAreaProvider>
      </Modal>
    </View>
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
  const tokens = useMobileTokens();
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
        <Pressable
          key={action.label}
          accessibilityLabel={action.label}
          onPress={() => void onRelease(action.reason)}
          hitSlop={8}
          style={{
            minHeight: 44,
            justifyContent: "center",
            borderWidth: 1,
            borderColor: action.primary ? tokens.primary : tokens.border,
            backgroundColor: action.primary ? tokens.primary : tokens.muted,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 10,
          }}
        >
          <Text style={{ color: action.primary ? tokens.primaryForeground : tokens.foreground }}>
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function ScreenWebView({
  url,
  interactive,
  onError,
}: {
  url: string;
  interactive: boolean;
  onError: () => void;
}) {
  const tokens = useMobileTokens();
  return (
    <WebView
      key={url}
      source={{ uri: url }}
      style={{ flex: 1, backgroundColor: tokens.background }}
      pointerEvents={interactive ? "auto" : "none"}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      originWhitelist={["*"]}
      mixedContentMode="always"
      setSupportMultipleWindows={false}
      scrollEnabled={false}
      overScrollMode="never"
      onError={onError}
      onHttpError={onError}
    />
  );
}
