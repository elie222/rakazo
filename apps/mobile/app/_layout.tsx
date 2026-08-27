import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AvatarStyleProvider } from "../components/avatar-style";
import { loadApiBase } from "../lib/api";
import { applyMobileUiDirection } from "../lib/ui-direction";

applyMobileUiDirection();

export default function Layout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void loadApiBase().finally(() => setReady(true));
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
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
        <View style={{ flex: 1, backgroundColor: "#000" }} />
      )}
    </GestureHandlerRootView>
  );
}
