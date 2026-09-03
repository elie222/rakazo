import { lightTokens } from "@rakazo/ui-tokens";
import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AvatarStyleProvider } from "../components/avatar-style";
import { currentApiBase, loadApiBase, loadSessionToken, selectedSpaceId } from "../lib/api";
import { loadAppearancePreference } from "../lib/appearance";
import { bootstrapI18n, useI18n } from "../lib/i18n";
import {
  configureForegroundNotifications,
  resumeLiveNotifications,
} from "../lib/live-notifications";
import { native, useResolvedAppearance } from "../lib/native";

configureForegroundNotifications();

const lightTheme = {
  ...DarkTheme,
  dark: false,
  colors: {
    ...DarkTheme.colors,
    primary: lightTokens.primary,
    background: lightTokens.background,
    card: lightTokens.background,
    text: lightTokens.foreground,
    border: lightTokens.border,
    notification: lightTokens.foreground,
  },
};

export default function Layout() {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const resolved = useResolvedAppearance();
  const navigationTheme = useMemo(() => {
    const base = resolved === "light" ? lightTheme : DarkTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: String(native.page),
        card: String(native.page),
        text: String(native.label),
        border: "transparent",
        primary: String(native.label),
      },
    };
  }, [resolved]);

  useEffect(() => {
    void Promise.all([
      Promise.all([loadApiBase(), loadAppearancePreference()])
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
            <ThemeProvider value={navigationTheme}>
              <StatusBar style={resolved === "light" ? "dark" : "light"} />
              <Stack
                screenOptions={{
                  headerStyle: { backgroundColor: String(native.page) },
                  headerTintColor: String(native.label),
                  headerShadowVisible: false,
                  headerBackButtonDisplayMode: "minimal",
                  contentStyle: { backgroundColor: String(native.page) },
                }}
              >
                <Stack.Screen name="index" options={{ headerShown: false, title: "Rakazo" }} />
                <Stack.Screen name="sign-in" options={{ headerShown: false }} />
                <Stack.Screen name="account" options={{ title: t("Account") }} />
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
                <Stack.Screen name="group-thread" options={{ title: t("Group") }} />
                <Stack.Screen name="group-settings" options={{ title: t("Group settings") }} />
                <Stack.Screen name="bot-settings" options={{ title: t("Chat settings") }} />
                <Stack.Screen name="thread" options={{ title: t("Thread") }} />
                <Stack.Screen name="routine" options={{ title: t("Routine") }} />
                <Stack.Screen name="computer" options={{ title: t("Computer") }} />
              </Stack>
            </ThemeProvider>
          </AvatarStyleProvider>
        ) : (
          <View style={{ flex: 1, backgroundColor: String(native.page) }} />
        )}
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
