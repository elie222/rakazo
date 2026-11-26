import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { useLingui } from "@lingui/react/macro";
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
  useSegments,
} from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { I18nManager, Platform, ScrollView, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardAvoidingView, KeyboardProvider } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CallCard } from "../components/calls/CallCard";
import { IncomingCall } from "../components/calls/IncomingCall";
import { VoicePlayerBar } from "../components/calls/voice-player-bar";
import { ComputerUpdateProgress } from "../components/computers/computer-update-progress";
import { CodeCopyButton } from "../components/messages/code-copy-button";
import { MermaidDiagram } from "../components/messages/mermaid-diagram";
import { MessageMenuHost } from "../components/messages/message-action-menu";
import { MessageActionSheetHost } from "../components/messages/message-action-sheet-host";
import { floatingHeaderOptions, glassHeaderOptions } from "../components/native/glass-title";
import { NativeSymbol } from "../components/native/native-symbol";
import { chatRouteHeader } from "../components/thread/header/chat-route-header";
import { AppErrorBoundary } from "../components/ui/app-error-boundary";
import {
  currentApiBase,
  rpc,
  selectedSpaceId,
  subscribeAiConsentGranted,
  subscribeApiBase,
  subscribeSessionRejected,
  subscribeSpaceSelection,
} from "../lib/api/api";
import { loadApiBase } from "../lib/api/api-server";
import { installClientUpdates, watchForegroundUpdates } from "../lib/api/client-update";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  loadSessionToken,
  registerSessionDiskCache,
  sessionOnlyInMemory,
  subscribeSessionGeneration,
} from "../lib/api/session";
import { loadAppearancePreference, mobileTokens } from "../lib/appearance/appearance";
import { capTextScaling } from "../lib/appearance/text-scale";
import { replaceWithSignIn } from "../lib/auth/auth-routing";
import { useReferral } from "../lib/billing/referral";
import { AvatarScreenFocus } from "../lib/bots/avatar-life";
import { CallKeyboardContext } from "../lib/calls/call-keyboard-context";
import { useCallActive } from "../lib/calls/call-session";
import { startIncomingCalls } from "../lib/calls/incoming-calls";
import { loadComposerEnterToSendPreference } from "../lib/composer/composer-enter-to-send-preference";
import { loadComposerModelPickerPreference } from "../lib/composer/composer-model-picker-preference";
import { bootstrapI18n, refreshDeviceDateFormat } from "../lib/i18n/i18n";
import { clearLastBot } from "../lib/inbox/last-bot";
import { clearSavedChats } from "../lib/inbox/saved-chats";
import { InboxBesideContext } from "../lib/layout/side-insets";
import {
  chooseInboxWidth,
  closesSplitPane,
  inboxPaneWidthDuringDrag,
  loadInboxWidth,
  useSplitView,
} from "../lib/layout/split-view";
import { loadLinkFavicon } from "../lib/messages/link-favicons";
import { OpenPageContext } from "../lib/messages/message-mentions";
import { loadHapticsPreference } from "../lib/native/haptics";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native/native";
import { useNavigatorMounted } from "../lib/navigation/navigator-mounted";
import { clearAppBadge } from "../lib/notifications/app-badge";
import {
  configureForegroundNotifications,
  resumeLiveNotifications,
} from "../lib/notifications/live-notifications";
import { useNotificationResponses } from "../lib/notifications/open-notification";
import { invalidateWatchChat } from "../lib/notifications/watch-chat";
import { startWorkActivities } from "../lib/notifications/work-activity";
import { subscribeAppState } from "../lib/platform/app-foreground";
import { setMobileMonitoringScreen } from "../lib/platform/monitoring";
import {
  completeMobileStartup,
  markMobileStartupMounted,
  trackMobileStartup,
} from "../lib/platform/startup";
import {
  getCachedRemoteImagesEnabled,
  loadRemoteImagesPreference,
  subscribeRemoteImages,
} from "../lib/preferences/remote-images-preference";
import { loadResponseStreamingPreference } from "../lib/preferences/response-streaming";
import { clearQueries, queryClient, resetRpcQueries } from "../lib/query/query";
import { clearSavedReads, keepSavedReads } from "../lib/query/saved-reads";
import {
  loadTrustedLinkSites,
  trustLinkSite,
  useTrustedLinkSites,
} from "../lib/settings/trusted-link-sites";
import { startUnsentSends } from "../lib/thread/send/unsent-sends";
import { InboxPane } from "./index";

// Before anything renders: text grows with the iOS text size only up to a fixed maximum.
capTextScaling();
configureForegroundNotifications();
registerSessionDiskCache(clearSavedChats);
registerSessionDiskCache(clearQueries);
keepSavedReads(queryClient);
registerSessionDiskCache(clearSavedReads);
subscribeAiConsentGranted(() => void resetRpcQueries("aiConsent/status"));
registerSessionDiskCache((sameAccount) => {
  if (!sameAccount) return clearLastBot();
});
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
  const segments = useSegments();
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
  // iOS presents settings as a sheet over the window; Android pushes them as a page, which
  // takes the whole window rather than sitting beside the chat list.
  const settingsPage = Platform.OS !== "ios" && segments[0] === "(settings)";
  const showsInbox = split && inboxShown && !FULL_WINDOW_ROUTES.has(pathname) && !settingsPage;
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
      paneWidth.value = inboxPaneWidthDuringDrag(
        windowWidth,
        dragStart.current,
        event.translationX,
        I18nManager.isRTL,
      );
    })
    .onEnd((_event, success) => {
      if (success) chooseInboxWidth(paneWidth.value);
    });
  const paneStyle = useAnimatedStyle(() => ({ width: paneWidth.value }));
  const handleStyle = useAnimatedStyle(() => ({ left: paneWidth.value - DIVIDER_GRAB_WIDTH / 2 }));
  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      {showsInbox ? (
        <Animated.View style={paneStyle}>
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
          {/* The divider line resizes the list: drawn last, with a grab area wider than the line
              over both panes, so it is easy to grab without a handle on show. */}
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
                backgroundColor: "transparent",
              },
              handleStyle,
            ]}
          >
            <View
              style={{ flex: 1, width: StyleSheet.hairlineWidth, backgroundColor: tokens.border }}
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
  const { t } = useLingui();
  const endpoint = useSyncExternalStore(subscribeApiBase, currentApiBase, currentApiBase);
  const linkFavicons = useMemo<LinkFavicons>(
    () => ({ endpoint, load: (origin) => loadLinkFavicon(origin, endpoint), globe: <LinkGlobe /> }),
    [endpoint],
  );
  const session = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  const trustedSites = useTrustedLinkSites();
  const router = useRouter();
  const openPage = useCallback(
    (pageId: string) => router.push({ pathname: "/page", params: { pageId } }),
    [router],
  );
  useEffect(() => {
    void loadTrustedLinkSites().catch(() => undefined);
  }, [endpoint, session]);
  return (
    <MarkdownLinkPromptProvider
      appOrigin={endpoint}
      copy={{
        title: t`Open external link?`,
        cancel: t`Cancel`,
        open: t`Open`,
        alwaysOpen: (site) => t`Always open ${site}`,
      }}
      trustedSites={trustedSites}
      trustSite={trustLinkSite}
    >
      <RemoteImagesContext.Provider value={loadRemoteImages}>
        <LinkFaviconsContext.Provider value={linkFavicons}>
          <MermaidDiagramContext.Provider value={MermaidDiagram}>
            <CodeCopyButtonContext.Provider value={CodeCopyButton}>
              <OpenPageContext.Provider value={openPage}>{children}</OpenPageContext.Provider>
            </CodeCopyButtonContext.Provider>
          </MermaidDiagramContext.Provider>
        </LinkFaviconsContext.Provider>
      </RemoteImagesContext.Provider>
    </MarkdownLinkPromptProvider>
  );
}

export const unstable_settings = { anchor: "index" };

function LayoutContent() {
  const call = useCallActive();
  const { t } = useLingui();
  const insets = useSafeAreaInsets();
  // Beside the list a chat swaps in place, the way it does when picked from a sidebar.
  const { split, inboxHidden, foldActive } = useSplitView();
  const canInvite = Boolean(useReferral());
  const router = useRouter();
  const chatAnimation = split ? "none" : undefined;
  const [ready, setReady] = useState(false);
  useNavigatorMounted(ready);
  useNotificationResponses(ready);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let active = true;
    const unsubscribeSpace = subscribeSpaceSelection(() =>
      invalidateWatchChat("space", selectedSpaceId() ?? ""),
    );
    const unsubscribe = subscribeSessionGeneration(() => {
      invalidateWatchChat("sessionUnavailable");
      const generation = currentSessionGeneration();
      if (generation !== currentReadySessionGeneration()) return;
      void loadSessionToken().then((token) => {
        // The native relay reads durable credentials only. A failed wipe or in-memory fallback
        // must never re-enable an earlier bearer from the iPhone's Keychain.
        if (active && token && generation === currentSessionGeneration() && !sessionOnlyInMemory())
          invalidateWatchChat("sessionReady");
      });
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeSpace();
    };
  }, []);
  const callSession = useSyncExternalStore(
    subscribeSessionGeneration,
    currentReadySessionGeneration,
  );
  useEffect(() => {
    if (!ready) return;
    return startIncomingCalls();
  }, [ready, callSession]);
  const pathname = usePathname();
  const screen = analyticsScreen(pathname);
  const monitoringScreen = pathname === "/share" ? "share" : screen;
  useEffect(() => setMobileMonitoringScreen(monitoringScreen), [monitoringScreen]);
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

  // Only once the saved server is restored: the card's check sends the session to it.
  useEffect(() => {
    if (!ready) return;
    return startWorkActivities();
  }, [ready]);

  useEffect(() => watchForegroundUpdates(), []);

  useEffect(
    () =>
      subscribeAppState((state) => {
        if (state === "active") void refreshDeviceDateFormat();
      }),
    [],
  );

  useEffect(() => {
    markMobileStartupMounted();
    void loadHapticsPreference();
    void Promise.all([
      Promise.all([
        trackMobileStartup("server", loadApiBase()),
        trackMobileStartup("appearance", loadAppearancePreference()).finally(() =>
          setAppearanceReady(true),
        ),
        trackMobileStartup("streaming", loadResponseStreamingPreference()),
        trackMobileStartup("images", loadRemoteImagesPreference()),
        trackMobileStartup("enterToSend", loadComposerEnterToSendPreference()),
        trackMobileStartup("modelPicker", loadComposerModelPickerPreference()),
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
              <CallKeyboardContext.Provider value={call}>
                <KeyboardAvoidingView enabled={call} behavior="padding" style={{ flex: 1 }}>
                  <SplitFrame>
                    <Stack
                      screenLayout={({ navigation, options, children }) => (
                        <AvatarScreenFocus navigation={navigation}>
                          {/* Sheets and modals cover the window, so the chat list is not beside them. */}
                          {options.presentation && options.presentation !== "card" ? (
                            <InboxBesideContext.Provider value={false}>
                              <CallKeyboardContext.Provider
                                value={Platform.OS === "ios" ? false : call}
                              >
                                {children}
                              </CallKeyboardContext.Provider>
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
                      <Stack.Screen
                        name="index"
                        options={{ headerShown: false, title: "Rakazo" }}
                      />
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
                          title: t`Server`,
                          // Android formSheet hides the header Save action.
                          presentation: Platform.OS === "ios" ? "formSheet" : "card",
                          sheetAllowedDetents: [0.6, 1],
                          sheetGrabberVisible: true,
                        }}
                      />
                      <Stack.Screen
                        name="invite"
                        options={{
                          headerShown: false,
                          presentation: "formSheet",
                          sheetAllowedDetents: "fitToContents",
                          sheetGrabberVisible: true,
                        }}
                      />
                      <Stack.Screen
                        name="new-bot"
                        options={{
                          title: t`New bot`,
                          presentation: "modal",
                          gestureEnabled: true,
                          headerBackVisible: false,
                        }}
                      />
                      <Stack.Screen
                        name="new-group"
                        options={{
                          title: t`New group chat`,
                          presentation: "modal",
                          gestureEnabled: true,
                        }}
                      />
                      <Stack.Screen
                        name="new-space"
                        options={{
                          title: t`New private space`,
                          presentation: "modal",
                          gestureEnabled: true,
                          headerBackVisible: false,
                        }}
                      />
                      <Stack.Screen
                        name="space-members"
                        options={{
                          title: t`Members`,
                          presentation: "modal",
                          gestureEnabled: true,
                          headerBackVisible: false,
                        }}
                      />
                      <Stack.Screen
                        name="new-organization"
                        options={{
                          headerShown: false,
                          presentation: "formSheet",
                          sheetAllowedDetents: "fitToContents",
                          sheetGrabberVisible: true,
                          contentStyle: { backgroundColor: native.groupedPage },
                        }}
                      />
                      <Stack.Screen name="artifacts" options={glassHeaderOptions(t`Artifacts`)} />
                      <Stack.Screen name="artifact" options={{ title: t`Artifact` }} />
                      <Stack.Screen name="pages" options={glassHeaderOptions(t`Pages`)} />
                      <Stack.Screen name="shared-pages" />
                      <Stack.Screen name="page-review" options={glassHeaderOptions(t`Page`)} />
                      <Stack.Screen
                        name="page"
                        options={{
                          headerShown: false,
                          // An iPad shows a page as a sheet over the chat; a phone shows it whole.
                          presentation:
                            Platform.OS === "ios" && Platform.isPad
                              ? "pageSheet"
                              : "fullScreenModal",
                        }}
                      />
                      <Stack.Screen
                        name="page-share"
                        options={{
                          title: t`Share`,
                          presentation: "formSheet",
                          sheetAllowedDetents: [0.6, 1],
                          sheetGrabberVisible: true,
                          contentStyle: { backgroundColor: native.groupedPage },
                        }}
                      />
                      <Stack.Screen
                        name="group-thread"
                        options={({ route }) => ({
                          title: t`Group`,
                          animation: chatAnimation,
                          ...chatRouteHeader(
                            route,
                            { split, inboxHidden, foldActive },
                            router,
                            canInvite,
                          ),
                        })}
                      />
                      <Stack.Screen
                        name="group-settings"
                        options={glassHeaderOptions(t`Group settings`)}
                      />
                      <Stack.Screen name="bot-profile" options={glassHeaderOptions(t`Profile`)} />
                      <Stack.Screen name="meetings" options={glassHeaderOptions(t`Meetings`)} />
                      <Stack.Screen
                        name="meeting-calendar"
                        options={glassHeaderOptions(t`Auto-join`)}
                      />
                      <Stack.Screen
                        name="meeting-transcript"
                        options={glassHeaderOptions(t`Transcript`)}
                      />
                      <Stack.Screen
                        name="bot-settings"
                        options={glassHeaderOptions(t`Chat settings`)}
                      />
                      <Stack.Screen name="bot-model" options={glassHeaderOptions(t`Model`)} />
                      <Stack.Screen
                        name="chat-model"
                        options={{
                          ...glassHeaderOptions(t`Model`),
                          presentation: Platform.OS === "ios" ? "formSheet" : "card",
                          sheetAllowedDetents: [0.6, 1],
                          sheetGrabberVisible: true,
                        }}
                      />
                      <Stack.Screen
                        name="thread"
                        options={({ route }) => ({
                          title: t`Thread`,
                          animation: chatAnimation,
                          ...chatRouteHeader(
                            route,
                            { split, inboxHidden, foldActive },
                            router,
                            canInvite,
                          ),
                        })}
                      />
                      <Stack.Screen name="routines" options={glassHeaderOptions(t`Routines`)} />
                      <Stack.Screen name="routine" options={glassHeaderOptions(t`Routine`)} />
                      <Stack.Screen
                        name="routine-runs"
                        options={glassHeaderOptions(t`Run history`)}
                      />
                      <Stack.Screen name="board" options={glassHeaderOptions(t`Board`)} />
                      <Stack.Screen name="computer" options={{ title: t`Computer` }} />
                      <Stack.Screen
                        name="image"
                        options={{
                          headerShown: false,
                          presentation: "transparentModal",
                          contentStyle: { backgroundColor: "transparent" },
                          animation: "fade",
                        }}
                      />
                    </Stack>
                  </SplitFrame>
                  <ScrollView
                    keyboardShouldPersistTaps="handled"
                    style={{ flexGrow: 0, flexShrink: 1, maxHeight: "50%" }}
                  >
                    <CallCard />
                    <VoicePlayerBar style={{ marginTop: 8, marginBottom: insets.bottom + 8 }} />
                  </ScrollView>
                </KeyboardAvoidingView>
              </CallKeyboardContext.Provider>
              <ComputerUpdateProgress />
              <MessageMenuHost />
              <MessageActionSheetHost />
              <IncomingCall />
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
    <I18nProvider i18n={i18n}>
      <AppErrorBoundary>
        <LayoutContent />
      </AppErrorBoundary>
    </I18nProvider>
  );
}
