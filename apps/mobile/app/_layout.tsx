import type { LinkFavicons } from "@rakazo/chat-ui/native";
import {
  CodeCopyButtonContext,
  LinkFaviconsContext,
  MarkdownLinkPromptProvider,
  MermaidDiagramContext,
  RemoteImagesContext,
} from "@rakazo/chat-ui/native";
import { analyticsScreen } from "@rakazo/core";
import {
  DarkTheme,
  Stack,
  ThemeProvider,
  useGlobalSearchParams,
  usePathname,
  useRouter,
} from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppErrorBoundary } from "../components/app-error-boundary";
import { CallCard } from "../components/CallCard";
import { chatRouteHeader } from "../components/chat-route-header";
import { CodeCopyButton } from "../components/code-copy-button";
import { ComputerUpdateProgress } from "../components/computer-update-progress";
import { floatingHeaderOptions, glassHeaderOptions } from "../components/glass-title";
import { MermaidDiagram } from "../components/mermaid-diagram";
import { MessageMenuHost } from "../components/message-action-menu";
import { MessageActionSheetHost } from "../components/message-action-sheet-host";
import { NativeSymbol } from "../components/native-symbol";
import { VoicePlayerBar } from "../components/voice-player-bar";
import {
  currentApiBase,
  loadApiBase,
  loadSessionToken,
  rpc,
  selectedSpaceId,
  subscribeApiBase,
  subscribeSessionRejected,
} from "../lib/api";
import { clearAppBadge } from "../lib/app-badge";
import { loadAppearancePreference, mobileTokens } from "../lib/appearance";
import { replaceWithSignIn } from "../lib/auth-routing";
import { AvatarScreenFocus } from "../lib/avatar-life";
import { installClientUpdates, watchForegroundUpdates } from "../lib/client-update";
import { bootstrapI18n, useI18n } from "../lib/i18n";
import { loadLinkFavicon } from "../lib/link-favicons";
import {
  configureForegroundNotifications,
  resumeLiveNotifications,
} from "../lib/live-notifications";
import { setMobileMonitoringScreen } from "../lib/monitoring";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useNotificationResponses } from "../lib/open-notification";
import { clearQueries } from "../lib/query";
import {
  getCachedRemoteImagesEnabled,
  loadRemoteImagesPreference,
  subscribeRemoteImages,
} from "../lib/remote-images-preference";
import { loadResponseStreamingPreference } from "../lib/response-streaming";
import { clearSavedChats } from "../lib/saved-chats";
import {
  currentReadySessionGeneration,
  registerSessionDiskCache,
  subscribeSessionGeneration,
} from "../lib/session";
import { InboxBesideContext } from "../lib/side-insets";
import {
  chooseInboxWidth,
  closesSplitPane,
  inboxPaneWidth,
  loadInboxWidth,
  setInboxHidden,
  useSplitView,
} from "../lib/split-view";
import {
  completeMobileStartup,
  markMobileStartupMounted,
  trackMobileStartup,
} from "../lib/startup";
import { capTextScaling } from "../lib/text-scale";
import {
  loadTrustedLinkSites,
  trustLinkSite,
  useTrustedLinkSites,
} from "../lib/trusted-link-sites";
import { startUnsentSends } from "../lib/unsent-sends";
import { InboxPane } from "./index";

// Before anything renders: text grows with the iOS text size only up to a fixed maximum.
capTextScaling();
configureForegroundNotifications();
registerSessionDiskCache(clearSavedChats);
registerSessionDiskCache(clearQueries);
installClientUpdates();
registerSessionDiskCache(() => void clearAppBadge());
// Keep the splash up until the saved appearance applies, so the first frame isn't in the OS scheme.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const DIVIDER_GRAB_WIDTH = 24;
// Screens that take the whole window even when it is wide enough for the chat list beside them.
const FULL_WINDOW_ROUTES = new Set(["/sign-in", "/server", "/image", "/computer", "/share"]);

/** On a wide window the chat list stays on the left and the stack shows the open chat beside it. */
function SplitFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useGlobalSearchParams();
  const routeKey = JSON.stringify([pathname, params]);
  const paneSpace = useRef<string | null>(null);
  // Capture the space when any route opens, including another entity on the same route.
  useEffect(() => {
    paneSpace.current = pathname === "/" ? null : selectedSpaceId();
  }, [routeKey]);
  const { split, inboxShown, inboxWidth, foldGap, foldActive, windowWidth } = useSplitView();
  const tokens = useMobileTokens();
  const home = pathname === "/";
  useEffect(() => {
    if (home) setInboxHidden(false);
  }, [home]);
  const showsInbox = split && (home || inboxShown) && !FULL_WINDOW_ROUTES.has(pathname);
  // Dragging resizes the list natively; the width is kept when the finger lifts.
  const paneWidth = useSharedValue(inboxWidth);
  const dragStart = useRef(inboxWidth);
  useEffect(() => {
    paneWidth.value = inboxWidth;
  }, [inboxWidth, paneWidth]);
  const resize = Gesture.Pan()
    .enabled(!foldActive)
    .runOnJS(true)
    .activeOffsetX([-4, 4])
    .onStart(() => {
      dragStart.current = paneWidth.value;
    })
    .onUpdate((event) => {
      paneWidth.value = inboxPaneWidth(windowWidth, dragStart.current + event.translationX);
    })
    .onEnd((_event, success) => {
      if (success) chooseInboxWidth(paneWidth.value);
    });
  const paneStyle = useAnimatedStyle(() => ({ width: paneWidth.value }));
  const handleStyle = useAnimatedStyle(() => ({ left: paneWidth.value - DIVIDER_GRAB_WIDTH / 2 }));
  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      {showsInbox ? (
        <Animated.View
          style={[
            paneStyle,
            { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: tokens.border },
          ]}
        >
          <InboxPane
            onSelectSpace={(spaceId) => {
              if (closesSplitPane(pathname, paneSpace.current, spaceId)) {
                router.dismissTo("/");
              }
            }}
          />
        </Animated.View>
      ) : null}
      {/* Keeps its place among the children so the navigation stack survives folding. */}
      <View style={{ flex: 1, marginLeft: showsInbox ? foldGap : 0 }}>
        <InboxBesideContext.Provider value={showsInbox}>{children}</InboxBesideContext.Provider>
      </View>
      {showsInbox && !foldActive ? (
        <GestureDetector gesture={resize}>
          {/* Drawn last and wider than the line, over both panes, so it is easy to grab. */}
          <Animated.View
            accessible={false}
            collapsable={false}
            style={[
              {
                position: "absolute",
                top: 0,
                bottom: 0,
                width: DIVIDER_GRAB_WIDTH,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "transparent",
              },
              handleStyle,
            ]}
          >
            <View
              style={{
                width: 5,
                height: 40,
                borderRadius: 3,
                backgroundColor: tokens.mutedForeground,
                opacity: 0.6,
              }}
            />
          </Animated.View>
        </GestureDetector>
      ) : null}
    </View>
  );
}

function LinkGlobe() {
  const tokens = useMobileTokens();
  return (
    <NativeSymbol ios="globe" android="globe-outline" size={16} color={tokens.mutedForeground} />
  );
}

function ChatContentProviders({
  loadRemoteImages,
  children,
}: {
  loadRemoteImages: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const endpoint = useSyncExternalStore(subscribeApiBase, currentApiBase, currentApiBase);
  const linkFavicons = useMemo<LinkFavicons>(
    () => ({ endpoint, load: (origin) => loadLinkFavicon(origin, endpoint), globe: <LinkGlobe /> }),
    [endpoint],
  );
  const session = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  const trustedSites = useTrustedLinkSites();
  useEffect(() => {
    void loadTrustedLinkSites().catch(() => undefined);
  }, [endpoint, session]);
  return (
    <MarkdownLinkPromptProvider
      appOrigin={endpoint}
      copy={{
        title: t("Open external link?"),
        cancel: t("Cancel"),
        open: t("Open"),
        alwaysOpen: (site) => t("Always open {site}", { site }),
      }}
      trustedSites={trustedSites}
      trustSite={trustLinkSite}
    >
      <RemoteImagesContext.Provider value={loadRemoteImages}>
        <LinkFaviconsContext.Provider value={linkFavicons}>
          <MermaidDiagramContext.Provider value={MermaidDiagram}>
            <CodeCopyButtonContext.Provider value={CodeCopyButton}>
              {children}
            </CodeCopyButtonContext.Provider>
          </MermaidDiagramContext.Provider>
        </LinkFaviconsContext.Provider>
      </RemoteImagesContext.Provider>
    </MarkdownLinkPromptProvider>
  );
}

export const unstable_settings = { anchor: "index" };

function LayoutContent() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  // Beside the list a chat swaps in place, the way it does when picked from a sidebar.
  const { split, inboxHidden, foldActive } = useSplitView();
  const chatAnimation = split ? "none" : undefined;
  const [ready, setReady] = useState(false);
  useNotificationResponses(ready);
  const screen = analyticsScreen(usePathname());
  useEffect(() => setMobileMonitoringScreen(screen), [screen]);
  useEffect(() => {
    const surface = Platform.OS;
    if (!ready || !screen || (surface !== "ios" && surface !== "android")) return;
    let active = true;
    void loadSessionToken()
      .then((token) => {
        if (active && token)
          return rpc("analytics/screen", { screen, surface }, { skipSpaceAuthRecovery: true });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [ready, screen]);
  const [appearanceReady, setAppearanceReady] = useState(false);
  const resolved = useResolvedAppearance();
  const loadRemoteImages = useSyncExternalStore(
    subscribeRemoteImages,
    getCachedRemoteImagesEnabled,
    () => false,
  );
  const navigationTheme = useMemo(() => {
    const tokens = mobileTokens();
    return {
      ...DarkTheme,
      dark: resolved === "dark",
      colors: {
        ...DarkTheme.colors,
        background: tokens.background,
        card: tokens.background,
        text: tokens.foreground,
        border: tokens.border,
        primary: tokens.primary,
        notification: tokens.foreground,
      },
    };
  }, [resolved]);

  useEffect(() => {
    if (appearanceReady && ready)
      void SplashScreen.hideAsync()
        .then(completeMobileStartup)
        .catch(() => undefined);
  }, [appearanceReady, ready]);

  useEffect(() => {
    if (!ready) return;
    // A session revoked or expired on the server ends here, from whichever screen noticed it.
    return subscribeSessionRejected(() => replaceWithSignIn());
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    return startUnsentSends();
  }, [ready]);

  useEffect(() => watchForegroundUpdates(), []);

  useEffect(() => {
    markMobileStartupMounted();
    void Promise.all([
      Promise.all([
        trackMobileStartup("server", loadApiBase()),
        trackMobileStartup("appearance", loadAppearancePreference()).finally(() =>
          setAppearanceReady(true),
        ),
        trackMobileStartup("streaming", loadResponseStreamingPreference()),
        trackMobileStartup("images", loadRemoteImagesPreference()),
        trackMobileStartup("inbox", loadInboxWidth()),
      ]).catch(() => undefined),
      trackMobileStartup("language", bootstrapI18n()).catch(() => undefined),
    ])
      .then(() => {
        // The native poller stores the locale its notification copy uses, so the
        // restart waits for the language to load rather than saving the default.
        // Notification restoration must not keep the native splash visible.
        void loadSessionToken()
          .then((token) =>
            resumeLiveNotifications(currentApiBase(), token, selectedSpaceId() ?? ""),
          )
          .catch(() => undefined);
      })
      .finally(() => setReady(true));
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        {ready ? (
          <ChatContentProviders loadRemoteImages={loadRemoteImages}>
            <ThemeProvider value={navigationTheme}>
              <StatusBar style={resolved === "light" ? "dark" : "light"} />
              <View style={{ flex: 1 }}>
                <SplitFrame>
                  <Stack
                    screenLayout={({ navigation, options, children }) => (
                      <AvatarScreenFocus navigation={navigation}>
                        {/* Sheets and modals cover the window, so the chat list is not beside them. */}
                        {options.presentation && options.presentation !== "card" ? (
                          <InboxBesideContext.Provider value={false}>
                            {children}
                          </InboxBesideContext.Provider>
                        ) : (
                          children
                        )}
                      </AvatarScreenFocus>
                    )}
                    screenOptions={{
                      headerStyle: { backgroundColor: navigationTheme.colors.background },
                      ...floatingHeaderOptions(),
                      headerTintColor: navigationTheme.colors.text,
                      headerShadowVisible: false,
                      headerBackButtonDisplayMode: "minimal",
                      contentStyle: { backgroundColor: String(native.page) },
                    }}
                  >
                    <Stack.Screen name="index" options={{ headerShown: false, title: "Rakazo" }} />
                    <Stack.Screen
                      name="search"
                      options={{
                        headerShown: false,
                        presentation: Platform.OS === "ios" ? "formSheet" : "card",
                        sheetAllowedDetents: [1],
                        sheetGrabberVisible: false,
                        sheetExpandsWhenScrolledToEdge: false,
                      }}
                    />
                    <Stack.Screen name="share" options={{ headerShown: false }} />
                    <Stack.Screen name="sign-in" options={{ headerShown: false }} />
                    <Stack.Screen
                      name="paywall"
                      options={{
                        headerShown: false,
                        presentation: "fullScreenModal",
                        gestureEnabled: false,
                      }}
                    />
                    <Stack.Screen
                      name="(settings)"
                      options={{
                        headerShown: false,
                        // One stack of settings pages in a sheet over the screen that opened it.
                        // Android keeps pushed pages: it has no nested stack inside a formSheet.
                        presentation: Platform.OS === "ios" ? "formSheet" : "card",
                        sheetAllowedDetents: [0.95],
                        sheetGrabberVisible: false,
                        sheetExpandsWhenScrolledToEdge: false,
                        contentStyle: { backgroundColor: native.groupedPage },
                      }}
                    />
                    <Stack.Screen
                      name="server"
                      options={{
                        title: t("Server"),
                        presentation: "formSheet",
                        sheetAllowedDetents: [0.6, 1],
                        sheetGrabberVisible: true,
                      }}
                    />
                    <Stack.Screen
                      name="new-group"
                      options={{
                        title: t("New group chat"),
                        presentation: "modal",
                        gestureEnabled: true,
                      }}
                    />
                    <Stack.Screen
                      name="new-space"
                      options={{
                        title: t("New private space"),
                        presentation: "modal",
                        gestureEnabled: true,
                        headerBackVisible: false,
                      }}
                    />
                    <Stack.Screen name="artifacts" options={glassHeaderOptions(t("Artifacts"))} />
                    <Stack.Screen name="artifact" options={{ title: t("Artifact") }} />
                    <Stack.Screen
                      name="group-thread"
                      options={({ route }) => ({
                        title: t("Group"),
                        animation: chatAnimation,
                        ...chatRouteHeader(route, t, { split, inboxHidden, foldActive }),
                      })}
                    />
                    <Stack.Screen
                      name="group-settings"
                      options={glassHeaderOptions(t("Group settings"))}
                    />
                    <Stack.Screen name="bot-profile" options={glassHeaderOptions(t("Profile"))} />
                    <Stack.Screen
                      name="bot-settings"
                      options={glassHeaderOptions(t("Chat settings"))}
                    />
                    <Stack.Screen name="bot-model" options={glassHeaderOptions(t("Model"))} />
                    <Stack.Screen
                      name="thread"
                      options={({ route }) => ({
                        title: t("Thread"),
                        animation: chatAnimation,
                        ...chatRouteHeader(route, t, { split, inboxHidden, foldActive }),
                      })}
                    />
                    <Stack.Screen name="routines" options={glassHeaderOptions(t("Routines"))} />
                    <Stack.Screen name="routine" options={glassHeaderOptions(t("Routine"))} />
                    <Stack.Screen name="computer" options={{ title: t("Computer") }} />
                    <Stack.Screen
                      name="image"
                      options={{
                        headerShown: false,
                        presentation: "fullScreenModal",
                        animation: "fade",
                      }}
                    />
                  </Stack>
                </SplitFrame>
                <VoicePlayerBar style={{ marginTop: 8, marginBottom: insets.bottom + 8 }} />
              </View>
              <ComputerUpdateProgress />
              <MessageMenuHost />
              <MessageActionSheetHost />
              <CallCard />
            </ThemeProvider>
          </ChatContentProviders>
        ) : (
          <View style={{ flex: 1, backgroundColor: String(native.page) }} />
        )}
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

export default function Layout() {
  return (
    <AppErrorBoundary>
      <LayoutContent />
    </AppErrorBoundary>
  );
}
