import { Stack } from "expo-router";
import { useTheme } from "expo-router/react-navigation";
import type { ReactNode } from "react";
import { native } from "../../lib/native/native";
import { floatingHeaderOptions } from "../native/glass-title";

/** The stack inside each tab: its own header and history, with the root stack's look. */
export function TabStack({ children }: { children?: ReactNode }) {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.background },
        ...floatingHeaderOptions(),
        headerTintColor: theme.colors.text,
        headerShadowVisible: false,
        headerBackButtonDisplayMode: "minimal",
        contentStyle: { backgroundColor: String(native.page) },
      }}
    >
      {children}
    </Stack>
  );
}
