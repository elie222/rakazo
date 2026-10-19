import type { LinkFavicons } from "@rakazo/chat-ui/native";
import {
  LinkFaviconsContext,
  MarkdownLinkPromptProvider,
  MermaidDiagramContext,
  RemoteImagesContext,
} from "@rakazo/chat-ui/native";
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
import { Dimensions, Platform, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AvatarStyleProvider } from "../components/avatar-style";
import { CallCard } from "../components/CallCard";
import { ComputerUpdateProgress } from "../components/computer-update-progress";
import { floatingHeaderOptions, glassHeaderOptions } from "../components/glass-title";
import { MermaidDiagram } from "../components/mermaid-diagram";
import { MessageMenuHost } from "../components/message-action-menu";
import { NativeSymbol } from "../components/native-symbol";
import { VoicePlayerBar } from "../components/voice-player-bar";
import {
  currentApiBase,
  loadApiBase,
  loadSessionToken,
  selectedSpaceId,
  subscribeApiBase,
  subscribeSessionRejected,
} from "../lib/api";
import { loadAppearancePreference, mobileTokens } from "../lib/appearance";
import { replaceWithSignIn } from "../lib/auth-routing";
import { loadAvatarStyle } from "../lib/avatar-style";
import { bootstrapI18n, useI18n } from "../lib/i18n";
import { loadLinkFavicon } from "../lib/link-favicons";
import {
  configureForegroundNotifications,
  resumeLiveNotifications,
} from "../lib/live-notifications";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useNotificationResponses } from "../lib/open-notification";
import { syncOrientation } from "../lib/orientation";
import {
  getCachedRemoteImagesEnabled,
  loadRemoteImagesPreference,
  subscribeRemoteImages,
} from "../lib/remote-images-preference";
import { loadResponseStreamingPreference } from "../lib/response-streaming";
import { clearSavedChats } from "../lib/saved-chats";
import { registerSessionDiskCache } from "../lib/session";
import {
  chooseInboxWidth,
  closesSplitPane,
  inboxPaneWidth,
  loadInboxWidth,
  setInboxHidden,
  useSplitView,
} from "../lib/split-view";
import { startUnsentSends } from "../lib/unsent-sends";
import { InboxPane } from "./index";

configureForegroundNotifications();
registerSessionDiskCache(clearSavedChats);
// Keep the splash up until the saved appearance applies, so the first frame isn't in the OS scheme.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

// Screens that take the whole window even when it is wide enough for the chat list beside them.
const DIVIDER_GRAB_WIDTH = 24;
const FULL_WINDOW_ROUTES = new Set(["/sign-in", "/server", "/image", "/computer"]);

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
  const { split, inboxHidden, inboxWidth, windowWidth } = useSplitView();
  const tokens = useMobileTokens();
  const home = pathname === "/";
  useEffect(() => {
    if (home) setInboxHidden(false);
  }, [home]);
  const showsInbox = split && (home || !inboxHidden) && !FULL_WINDOW_ROUTES.has(pathname);
  // Dragging resizes the list natively; the width is kept when the finger lifts.
  const paneWidth = useSharedValue(inboxWidth);
  const dragStart = useRef(inboxWidth);
  useEffect(() => {
    paneWidth.value = inboxWidth;
  }, [inboxWidth, paneWidth]);
  const resize = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-4, 4])
    .onStart(() => {
      dragStart.current = paneWidth.value;
    })
    .onUpdate((event) => {
      paneWidth.value = inboxPaneWidth(windowWidth, dragStart.current + event.translationX);
    })
    .onEnd(() => chooseInboxWidth(paneWidth.value));
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
      <View style={{ flex: 1 }}>{children}</View>
      {showsInbox ? (
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
  return (
    <MarkdownLinkPromptProvider
      appOrigin={endpoint}
      copy={{ title: t("Open external link?"), cancel: t("Cancel"), open: t("Open") }}
    >
      <RemoteImagesContext.Provider value={loadRemoteImages}>
        <LinkFaviconsContext.Provider value={linkFavicons}>
          <MermaidDiagramContext.Provider value={MermaidDiagram}>
            {children}
          </MermaidDiagramContext.Provider>
        </LinkFaviconsContext.Provider>
      </RemoteImagesContext.Provider>
    </MarkdownLinkPromptProvider>
  );
}

export default function Layout() {
  useEffect(() => {
    // Screen changes include folding; window resizing must not lock a tablet in split-screen.
    const subscription = Dimensions.addEventListener("change", () => {
      void syncOrientation();
    });
    void syncOrientation();
    return () => subscription.remove();
  }, []);
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  // Beside the list a chat swaps in place, the way it does when picked from a sidebar.
  const chatAnimation = useSplitView().split ? "none" : undefined;
  const [ready, setReady] = useState(false);
  useNotificationResponses(ready);
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
    if (appearanceReady && ready) void SplashScreen.hideAsync().catch(() => undefined);
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

  useEffect(() => {
    void Promise.all([
      Promise.all([
        loadApiBase(),
        loadAppearancePreference().finally(() => setAppearanceReady(true)),
        loadResponseStreamingPreference(),
        loadRemoteImagesPreference(),
        loadAvatarStyle(),
        loadInboxWidth(),
      ])
        .then(async () =>
          resumeLiveNotifications(
            currentApiBase(),
            await loadSessionToken(),
            selectedSpaceId() ?? "",
          ),
        )
        .catch(() => undefined),
      bootstrapI18n(),
    ]).finally(() => setReady(true));
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        {ready ? (
          <AvatarStyleProvider>
            <ChatContentProviders loadRemoteImages={loadRemoteImages}>
              <ThemeProvider value={navigationTheme}>
                <StatusBar style={resolved === "light" ? "dark" : "light"} />
                <View style={{ flex: 1 }}>
                  <SplitFrame>
                    <Stack
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
                      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
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
                        name="new"
                        options={{
                          title: t("New bot"),
                          presentation: "modal",
                          gestureEnabled: true,
                          headerBackVisible: false,
                        }}
                      />
                      <Stack.Screen
                        name="new-group"
                        options={{
                          title: t("New group"),
                          presentation: "modal",
                          gestureEnabled: true,
                        }}
                      />
                      <Stack.Screen
                        name="new-space"
                        options={{
                          title: t("New space"),
                          presentation: "modal",
                          gestureEnabled: true,
                          headerBackVisible: false,
                        }}
                      />
                      <Stack.Screen name="artifacts" options={glassHeaderOptions(t("Artifacts"))} />
                      <Stack.Screen name="artifact" options={{ title: t("Artifact") }} />
                      <Stack.Screen
                        name="group-thread"
                        options={{ title: t("Group"), animation: chatAnimation }}
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
                      <Stack.Screen
                        name="thread"
                        options={{ title: t("Thread"), animation: chatAnimation }}
                      />
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
                <CallCard />
              </ThemeProvider>
            </ChatContentProviders>
          </AvatarStyleProvider>
        ) : (
          <View style={{ flex: 1, backgroundColor: String(native.page) }} />
        )}
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
