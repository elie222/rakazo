import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { currentApiBase, rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import type { ComputerStatus } from "../../lib/computer";
import {
  embeddableScreenUrl,
  nextLoadedScreenUrl,
  previewPlaceholder,
  readScreenUrl,
  SCREEN_URL_OPEN_ATTEMPTS,
  screenStreamKey,
} from "../../lib/computer";
import { createComputerRefresh } from "../../lib/computer-refresh";
import { useI18n } from "../../lib/i18n";
import { useThemedStyles } from "../../lib/native";
import {
  hideSystemFloat,
  hideSystemFloatWindow,
  requestSystemFloatPermission,
  showSystemFloat,
  showSystemFloatWindow,
  systemFloatHasPermission,
  updateSystemFloatWindowUrl,
} from "../../lib/system-float";
import { isComputerRunning } from "../../lib/use-computer-running";
import { NativeSymbol } from "../native-symbol";

/** The float's default width; its screen keeps a 16:10 frame under a 36pt title bar. */
export const COMPUTER_FLOAT_WIDTH = 300;
/** The narrowest float: its screen stays 160×100, enough to read the status and the picture. */
export const COMPUTER_FLOAT_MIN_WIDTH = 160;
const COMPUTER_FLOAT_BAR_HEIGHT = 36;
/** Where the float rests when first opened: below the header, against the right edge. */
const COMPUTER_FLOAT_TOP = 120;
const COMPUTER_FLOAT_EDGE = 16;
/** The resize grip's touch target in the float's bottom-right corner. */
const COMPUTER_FLOAT_GRIP_SIZE = 28;

/** Keep a dragged float inside the window, with a margin at every edge. */
export function clampFloatPosition(
  x: number,
  y: number,
  windowWidth: number,
  windowHeight: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: Math.min(
      Math.max(x, COMPUTER_FLOAT_EDGE),
      Math.max(COMPUTER_FLOAT_EDGE, windowWidth - width - COMPUTER_FLOAT_EDGE),
    ),
    y: Math.min(
      Math.max(y, COMPUTER_FLOAT_EDGE),
      Math.max(COMPUTER_FLOAT_EDGE, windowHeight - height - COMPUTER_FLOAT_EDGE),
    ),
  };
}

/**
 * Keep a resized float between its minimum and 90% of the screen on either side: the width
 * must fit 90% of the width, and the 16:10 screen plus its title bar must fit 90% of the
 * height. A tiny screen clamps the maximum down to the minimum rather than below it.
 */
export function clampFloatWidth(width: number, windowWidth: number, windowHeight: number): number {
  const maxWidth = Math.max(
    COMPUTER_FLOAT_MIN_WIDTH,
    Math.min(windowWidth * 0.9, (windowHeight * 0.9 - COMPUTER_FLOAT_BAR_HEIGHT) * 1.6),
  );
  return Math.min(Math.max(width, COMPUTER_FLOAT_MIN_WIDTH), maxWidth);
}

/** The float's full height for a width: the 16:10 screen plus its title bar. */
export function floatHeightForWidth(width: number): number {
  return Math.round((width * 10) / 16) + COMPUTER_FLOAT_BAR_HEIGHT;
}

function createComputerFloatStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    float: {
      position: "absolute",
      zIndex: 10,
      elevation: 8,
      backgroundColor: tokens.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
      borderRadius: 12,
      overflow: "hidden",
    },
    bar: {
      height: COMPUTER_FLOAT_BAR_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      paddingStart: 12,
      paddingEnd: 4,
      gap: 8,
    },
    title: {
      flex: 1,
      fontSize: 13,
      fontWeight: "600",
      color: tokens.foreground,
    },
    body: {
      flex: 1,
      backgroundColor: tokens.background,
    },
    screen: {
      flex: 1,
      backgroundColor: tokens.background,
    },
    fallback: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
    },
    fallbackText: {
      fontSize: 13,
      color: tokens.mutedForeground,
      textAlign: "center",
    },
    grip: {
      position: "absolute",
      right: 0,
      bottom: 0,
      width: COMPUTER_FLOAT_GRIP_SIZE,
      height: COMPUTER_FLOAT_GRIP_SIZE,
      alignItems: "center",
      justifyContent: "center",
    },
  });
}

/**
 * A draggable, resizable float over the chat showing the bot's live computer screen. It
 * opens only from its header entry, never on its own. Closing it stops its status poll and
 * screen: the refresh controller is disposed with the window. A run ending while it is open
 * closes it too; a manual close never reopens it, and a run that already ended before an
 * open leaves the window alone. A screen that fails to load shows only the computer's
 * status text, never an error popup.
 */
export function ComputerFloatWindow({
  botId,
  name,
  open,
  onClose,
}: {
  botId: string | undefined;
  /** The bot's name, for the status text when there is no screen to show. */
  name?: string;
  /** Closed renders nothing, so nothing polls or refreshes while it is hidden. */
  open: boolean;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const styles = useThemedStyles(createComputerFloatStyles);
  const windowSize = useWindowDimensions();
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [screenFailed, setScreenFailed] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [size, setSize] = useState({ width: COMPUTER_FLOAT_WIDTH });
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  // The computer screen is floating outside the app, as a system window
  // or — when the window module is not in the build — as a bubble.
  const [systemFloatOn, setSystemFloatOn] = useState(false);
  const systemFloatMode = useRef<"window" | "bubble" | null>(null);
  // The user was sent to system settings to grant the overlay permission.
  const pendingPermission = useRef(false);
  const heldScreenUrl = useRef<string | null>(null);
  // The latest screen URL, for the pop-out button and the permission return.
  const floatScreenUrlRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const wasRunningRef = useRef(false);

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
          setStatusError(false);
        },
        onScreen: setScreenUrl,
        onReady: () => undefined,
        onInitialError: () => setStatusError(true),
      }),
    [botId],
  );

  // The status poll runs every two seconds inside createComputerRefresh, and the screen URL
  // is re-read only when the status shaping it changes or its capability nears expiry.
  useEffect(() => {
    if (!open || !botId) return;
    refreshController.start();
    // Read the screen with the open attempts, like the computer screen does on open.
    void refreshController
      .refresh({ screenAttempts: SCREEN_URL_OPEN_ATTEMPTS })
      .catch(() => undefined);
    return () => refreshController.dispose();
  }, [open, botId, refreshController]);

  // A new bot starts from a clean window: no stale screen, status, size or position.
  useEffect(() => {
    setComputer(null);
    setScreenUrl(null);
    setScreenFailed(false);
    setStatusError(false);
    setSize({ width: COMPUTER_FLOAT_WIDTH });
    setPosition(null);
    wasRunningRef.current = false;
  }, [botId]);
  useEffect(() => {
    if (open) setScreenFailed(false);
  }, [open]);

  // Closing the window takes the system float with it: its return target is gone.
  useEffect(() => {
    if (!open && systemFloatOn) {
      systemFloatMode.current = null;
      setSystemFloatOn(false);
      void hideSystemFloatWindow();
      void hideSystemFloat();
    }
  }, [open, systemFloatOn]);

  // After the user opens the system settings to grant the overlay permission,
  // the screen floats once they come back to the app: the system window
  // first, the bubble when the window module is not in the build.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !pendingPermission.current) return;
      pendingPermission.current = false;
      void systemFloatHasPermission().then((granted) => {
        if (!granted) return;
        const url = floatScreenUrlRef.current;
        if (url) {
          void showSystemFloatWindow(url, t("Computer screen"), locale).then((result) => {
            if (result === "shown") {
              systemFloatMode.current = "window";
              setSystemFloatOn(true);
              return;
            }
            if (result === "no-permission") return;
            void showSystemFloat().then((bubbleResult) => {
              if (bubbleResult === "shown") {
                systemFloatMode.current = "bubble";
                setSystemFloatOn(true);
              }
            });
          });
          return;
        }
        void showSystemFloat().then((result) => {
          if (result === "shown") {
            systemFloatMode.current = "bubble";
            setSystemFloatOn(true);
          }
        });
      });
    });
    return () => subscription.remove();
  }, [locale, t]);
  useEffect(() => {
    if (open) wasRunningRef.current = false;
  }, [open]);
  useEffect(() => {
    const running = isComputerRunning(computer);
    if (wasRunningRef.current && !running) {
      onCloseRef.current();
    }
    wasRunningRef.current = running;
  }, [computer]);

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl, currentApiBase());
  // A new stream clears a stale load failure; a rotated capability of the same stream doesn't.
  const embeddedScreenStream = embeddedScreenUrl ? screenStreamKey(embeddedScreenUrl) : null;
  useEffect(() => {
    setScreenFailed(false);
  }, [embeddedScreenStream]);

  const width = clampFloatWidth(size.width, windowSize.width, windowSize.height);
  const totalHeight = floatHeightForWidth(width);
  const rest = {
    x: windowSize.width - width - COMPUTER_FLOAT_EDGE,
    y: COMPUTER_FLOAT_TOP,
  };
  const positionNow = clampFloatPosition(
    position?.x ?? rest.x,
    position?.y ?? rest.y,
    windowSize.width,
    windowSize.height,
    width,
    totalHeight,
  );
  const positionRef = useRef(positionNow);
  positionRef.current = positionNow;
  const widthRef = useRef(width);
  widthRef.current = width;
  const windowSizeRef = useRef(windowSize);
  windowSizeRef.current = windowSize;
  const dragBase = useRef({ x: 0, y: 0 });
  const resizeBase = useRef({ width });

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 4 || Math.abs(gesture.dy) > 4,
      onPanResponderGrant: () => {
        dragBase.current = positionRef.current;
      },
      onPanResponderMove: (_event, gesture) => {
        setPosition({
          x: dragBase.current.x + gesture.dx,
          y: dragBase.current.y + gesture.dy,
        });
      },
      onPanResponderRelease: () => undefined,
    }),
  ).current;

  // The corner grip resizes only; the title bar moves only, so the gestures never compete.
  // The frame stays 16:10, so the drag takes its dominant axis: a diagonal drag grows width
  // and height together, and the picture never stretches.
  const resizeResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        resizeBase.current = { width: widthRef.current };
        // Pin the top-left corner before growing: a docked float otherwise re-anchors
        // to its right edge on every width change, and the grip would not track the finger.
        setPosition(positionRef.current);
      },
      onPanResponderMove: (_event, gesture) => {
        const delta = Math.max(gesture.dx, gesture.dy * 1.6);
        const next = resizeBase.current.width + delta;
        const window = windowSizeRef.current;
        setSize({ width: clampFloatWidth(next, window.width, window.height) });
      },
      onPanResponderRelease: () => undefined,
    }),
  ).current;

  /**
   * Floats the computer screen outside the app: the system window carries
   * the live screen over other apps, and the bubble is the fallback when
   * the window module is not in the build. The in-app window stays open
   * either way: the system float only shows once the app is in the
   * background, and tapping it brings the app back to this window.
   */
  async function toggleSystemFloat() {
    if (systemFloatOn) {
      systemFloatMode.current = null;
      setSystemFloatOn(false);
      await hideSystemFloatWindow();
      await hideSystemFloat();
      return;
    }
    const url = floatScreenUrlRef.current;
    if (url) {
      const result = await showSystemFloatWindow(url, t("Computer screen"), locale);
      if (result === "shown") {
        systemFloatMode.current = "window";
        setSystemFloatOn(true);
        return;
      }
      if (result === "no-permission") {
        askOverlayPermission();
        return;
      }
      // "unsupported": this build has no window module, so try the bubble.
    }
    const result = await showSystemFloat();
    if (result === "shown") {
      systemFloatMode.current = "bubble";
      setSystemFloatOn(true);
      return;
    }
    if (result === "no-permission") {
      askOverlayPermission();
      return;
    }
    Alert.alert(
      t("Can't float outside the app"),
      t(
        "The system floating window isn't available in this build. The computer screen stays inside the app.",
      ),
    );
  }

  function askOverlayPermission() {
    Alert.alert(
      t("Allow floating over other apps"),
      t(
        "Turn on “Display over other apps” for Rakazo in Settings. Then leave the app and the computer screen floats over other apps; tap the window or its notification to come back.",
      ),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Open Settings"),
          onPress: () => {
            pendingPermission.current = true;
            void requestSystemFloatPermission();
          },
        },
      ],
    );
  }

  const screenVisible =
    computer?.state === "running" && Boolean(embeddedScreenUrl) && !screenFailed;
  // The live stream survives capability rotation; hiding the window forgets the held URL.
  const loadedScreenUrl = nextLoadedScreenUrl(
    heldScreenUrl.current,
    embeddedScreenUrl,
    screenVisible,
  );
  heldScreenUrl.current = loadedScreenUrl;
  floatScreenUrlRef.current = loadedScreenUrl;

  // A rotated capability re-points the system window at the new screen URL.
  // This effect stays above the early return, like every other hook here.
  useEffect(() => {
    if (systemFloatMode.current !== "window" || !loadedScreenUrl) return;
    void updateSystemFloatWindowUrl(loadedScreenUrl);
  }, [loadedScreenUrl]);

  if (!open || !botId) return null;

  return (
    <View
      style={[
        styles.float,
        { left: positionNow.x, top: positionNow.y, width, height: totalHeight },
      ]}
    >
      <View style={styles.bar} {...panResponder.panHandlers}>
        <Text numberOfLines={1} style={styles.title}>
          {t("Computer screen")}
        </Text>
        {Platform.OS === "android" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              systemFloatOn ? t("Stop floating outside the app") : t("Float outside the app")
            }
            accessibilityState={{ selected: systemFloatOn }}
            hitSlop={8}
            onPress={() => void toggleSystemFloat()}
          >
            <NativeSymbol
              ios="arrow.up.forward.app"
              android="open-outline"
              size={18}
              color={systemFloatOn ? mobileTokens().primary : undefined}
            />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Close")}
          hitSlop={8}
          onPress={onClose}
        >
          <NativeSymbol ios="xmark" android="close-outline" size={18} />
        </Pressable>
      </View>
      <View style={styles.body}>
        {loadedScreenUrl ? (
          <WebView
            accessibilityLabel={t("Computer screen")}
            style={styles.screen}
            source={{ uri: loadedScreenUrl }}
            scrollEnabled={false}
            onLoad={() => setScreenFailed(false)}
            onError={() => setScreenFailed(true)}
            onHttpError={() => setScreenFailed(true)}
          />
        ) : (
          <View style={styles.fallback}>
            {statusError ? (
              <Text style={styles.fallbackText}>{t("Could not open computer")}</Text>
            ) : !computer ? (
              <ActivityIndicator />
            ) : (
              <Text style={styles.fallbackText}>
                {previewPlaceholder(computer.state, false, name ?? t("Bot"), computer.mode)}
              </Text>
            )}
          </View>
        )}
      </View>
      <View
        accessible
        accessibilityLabel={t("Resize")}
        style={styles.grip}
        {...resizeResponder.panHandlers}
      >
        <NativeSymbol
          ios="arrow.up.left.and.arrow.down.right"
          android="expand-outline"
          size={14}
          color={mobileTokens().mutedForeground}
        />
      </View>
    </View>
  );
}
