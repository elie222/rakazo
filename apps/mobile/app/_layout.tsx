import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AvatarStyleProvider } from "../components/avatar-style";
import { currentApiBase, loadApiBase, loadSessionToken, selectedSpaceId } from "../lib/api";
import { bootstrapI18n, useI18n } from "../lib/i18n";
import {
  configureForegroundNotifications,
  resumeLiveNotifications,
} from "../lib/live-notifications";

configureForegroundNotifications();

export default function Layout() {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void Promise.all([
      loadApiBase()
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
            <ThemeProvider value={DarkTheme}>
              <StatusBar style="light" />
              <Stack
                screenOptions={{
                  headerStyle: { backgroundColor: "#000" },
                  headerTintColor: "#ECECEE",
                  headerShadowVisible: false,
                  headerBackButtonDisplayMode: "minimal",
                  contentStyle: { backgroundColor: "#000" },
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
          <View style={{ flex: 1, backgroundColor: "#000" }} />
        )}
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
