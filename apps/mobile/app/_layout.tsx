import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { loadApiBase } from "../lib/api";

export default function Layout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void loadApiBase().finally(() => setReady(true));
  }, []);

  if (!ready) {
    return <View style={{ flex: 1, backgroundColor: "#000" }} />;
  }

  return (
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
        <Stack.Screen
          name="new"
          options={{
            title: "New bot",
            presentation: "modal",
            gestureEnabled: true,
            headerBackVisible: false,
          }}
        />
        <Stack.Screen name="thread" options={{ title: "Thread" }} />
        <Stack.Screen name="computer" options={{ title: "Computer" }} />
      </Stack>
    </ThemeProvider>
  );
}
