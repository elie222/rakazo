import { RemoteImagesContext } from "@rakazo/chat-ui/native";
import { DarkTheme, router, Stack, ThemeProvider } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AvatarStyleProvider } from "../components/avatar-style";
import { CallCard } from "../components/CallCard";
import { ComputerUpdateProgress } from "../components/computer-update-progress";
import { VoicePlayerBar } from "../components/voice-player-bar";
import {
  currentApiBase,
  loadApiBase,
  loadSessionToken,
  selectedSpaceId,
  subscribeSessionRejected,
} from "../lib/api";
import { loadAppearancePreference, mobileTokens } from "../lib/appearance";
import { explicitSignInRoute } from "../lib/auth-routing";
import { loadAvatarStyle } from "../lib/avatar-style";
import { bootstrapI18n, useI18n } from "../lib/i18n";
import {
  configureForegroundNotifications,
  resumeLiveNotifications,
} from "../lib/live-notifications";
import { native, useResolvedAppearance } from "../lib/native";
import { useNotificationResponses } from "../lib/open-notification";
import {
  getCachedRemoteImagesEnabled,
  loadRemoteImagesPreference,
  subscribeRemoteImages,
} from "../lib/remote-images-preference";
import { loadResponseStreamingPreference } from "../lib/response-streaming";

configureForegroundNotifications();
// Keep the splash up until the saved appearance applies, so the first frame isn't in the OS scheme.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function Layout() {
  useEffect(() => {
    // The app is portrait-only; the computer screen unlocks rotation while it is open.
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(
      () => undefined,
    );
  }, []);
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
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
    return subscribeSessionRejected(() => {
      if (router.canDismiss()) router.dismissAll();
      router.replace(explicitSignInRoute);
    });
  }, [ready]);

  useEffect(() => {
    void Promise.all([
      Promise.all([
        loadApiBase(),
        loadAppearancePreference().finally(() => setAppearanceReady(true)),
        loadResponseStreamingPreference(),
        loadRemoteImagesPreference(),
        loadAvatarStyle(),
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
            <RemoteImagesContext.Provider value={loadRemoteImages}>
              <ThemeProvider value={navigationTheme}>
                <StatusBar style={resolved === "light" ? "dark" : "light"} />
                <View style={{ flex: 1 }}>
                  <Stack
                    screenOptions={{
                      headerStyle: { backgroundColor: navigationTheme.colors.background },
                      headerTintColor: navigationTheme.colors.text,
                      headerShadowVisible: false,
                      headerBackButtonDisplayMode: "minimal",
                      contentStyle: { backgroundColor: String(native.page) },
                    }}
                  >
                    <Stack.Screen name="index" options={{ headerShown: false, title: "Rakazo" }} />
                    <Stack.Screen name="sign-in" options={{ headerShown: false }} />
                    <Stack.Screen
                      name="integration-setup"
                      options={{ title: t("Server integrations") }}
                    />
                    <Stack.Screen name="ai-data-sharing" options={{ title: "AI data sharing" }} />
                    <Stack.Screen name="account" options={{ title: t("Account") }} />
                    <Stack.Screen
                      name="change-password"
                      options={{
                        title: t("Change password"),
                        presentation: "formSheet",
                        sheetAllowedDetents: [0.6, 1],
                        sheetGrabberVisible: true,
                        // Expo Router makes formSheet headers transparent on Liquid Glass, which
                        // puts the first field under the bar; keep it opaque so the form starts below.
                        headerTransparent: false,
                      }}
                    />
                    <Stack.Screen name="models" options={{ title: t("Models") }} />
                    <Stack.Screen name="voice" options={{ title: t("Voice") }} />
                    <Stack.Screen name="integrations" options={{ title: t("Integrations") }} />
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
                    <Stack.Screen name="artifacts" options={{ title: t("Artifacts") }} />
                    <Stack.Screen name="artifact" options={{ title: t("Artifact") }} />
                    <Stack.Screen name="group-thread" options={{ title: t("Group") }} />
                    <Stack.Screen name="group-settings" options={{ title: t("Group settings") }} />
                    <Stack.Screen name="bot-settings" options={{ title: t("Chat settings") }} />
                    <Stack.Screen name="thread" options={{ title: t("Thread") }} />
                    <Stack.Screen name="routine" options={{ title: t("Routine") }} />
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
                  <VoicePlayerBar style={{ marginTop: 8, marginBottom: insets.bottom + 8 }} />
                </View>
                <ComputerUpdateProgress />
                <CallCard />
              </ThemeProvider>
            </RemoteImagesContext.Provider>
          </AvatarStyleProvider>
        ) : (
          <View style={{ flex: 1, backgroundColor: String(native.page) }} />
        )}
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
