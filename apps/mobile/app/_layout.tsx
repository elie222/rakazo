import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { AvatarStyleProvider } from "../components/avatar-style";
import { currentApiBase, loadApiBase, loadSessionToken, selectedSpaceId } from "../lib/api";
import { loadAppearancePreference } from "../lib/appearance";
import {
  configureForegroundNotifications,
  resumeLiveNotifications,
} from "../lib/live-notifications";
import { native, useResolvedAppearance } from "../lib/native";
import { applyMobileUiDirection } from "../lib/ui-direction";

applyMobileUiDirection();
configureForegroundNotifications();

const lightTheme = {
  ...DarkTheme,
  dark: false,
  colors: {
    ...DarkTheme.colors,
    primary: "#1A1A1A",
    background: "#F4F4F2",
    card: "#F4F4F2",
    text: "#1A1A1A",
    border: "#D0D0CC",
    notification: "#2A9E86",
  },
};

export default function Layout() {
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
    void Promise.all([loadApiBase(), loadAppearancePreference()])
      .then(async () =>
        resumeLiveNotifications(
          currentApiBase(),
          await loadSessionToken(),
          selectedSpaceId() ?? "",
        ),
      )
      .catch(() => undefined)
      .finally(() => setReady(true));
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
                <Stack.Screen name="account" options={{ title: "Account" }} />
                <Stack.Screen name="models" options={{ title: "Models" }} />
                <Stack.Screen name="voice" options={{ title: "Voice" }} />
                <Stack.Screen name="integrations" options={{ title: "Integrations" }} />
                <Stack.Screen
                  name="new"
                  options={{
                    title: "New bot",
                    presentation: "modal",
                    gestureEnabled: true,
                    headerBackVisible: false,
                  }}
                />
                <Stack.Screen
                  name="new-group"
                  options={{
                    title: "New group",
                    presentation: "modal",
                    gestureEnabled: true,
                  }}
                />
                <Stack.Screen
                  name="new-space"
                  options={{
                    title: "New space",
                    presentation: "modal",
                    gestureEnabled: true,
                    headerBackVisible: false,
                  }}
                />
                <Stack.Screen name="group-thread" options={{ title: "Group" }} />
                <Stack.Screen name="group-settings" options={{ title: "Group settings" }} />
                <Stack.Screen name="bot-settings" options={{ title: "Chat settings" }} />
                <Stack.Screen name="thread" options={{ title: "Thread" }} />
                <Stack.Screen name="routine" options={{ title: "Routine" }} />
                <Stack.Screen name="computer" options={{ title: "Computer" }} />
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
