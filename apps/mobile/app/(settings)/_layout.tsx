import { Stack, useNavigation } from "expo-router";
import { HeaderBackButton } from "expo-router/react-navigation";
import { useEffect } from "react";
import { Platform } from "react-native";
import { floatingHeaderOptions, glassHeaderOptions } from "../../components/glass-title";
import { useI18n } from "../../lib/i18n";
import { native, useMobileTokens } from "../../lib/native";
import { registerSettingsSheet, settingsSheetCloser } from "../../lib/settings-sheet";

/** Settings pages share one stack, which the root layout presents as a sheet on iOS. */
export default function SettingsLayout() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const sheet = useNavigation();
  const close = settingsSheetCloser(sheet);

  useEffect(() => registerSettingsSheet(settingsSheetCloser(sheet)), [sheet]);

  return (
    <Stack
      screenOptions={({ navigation, route }) => ({
        headerStyle: { backgroundColor: tokens.background },
        ...floatingHeaderOptions(),
        headerTintColor: tokens.foreground,
        headerShadowVisible: false,
        headerBackButtonDisplayMode: "minimal",
        // Account has no visible title, so iOS's long-press back menu would list it as a blank entry.
        headerBackButtonMenuEnabled: false,
        contentStyle: { backgroundColor: String(native.page) },
        // The first page closes the sheet, or returns Home when opened by a cold deep link.
        // The inner stack has no native back arrow on its first page.
        ...(navigation.getState().routes[0]?.key === route.key
          ? Platform.OS === "ios"
            ? {
                unstable_headerLeftItems: () => [
                  {
                    type: "button" as const,
                    label: t("Dismiss"),
                    icon: { type: "sfSymbol" as const, name: "xmark" as const },
                    onPress: close,
                  },
                ],
              }
            : {
                headerBackVisible: false,
                headerLeft: ({ tintColor }) => (
                  <HeaderBackButton
                    accessibilityLabel={t("Back")}
                    displayMode="minimal"
                    tintColor={tintColor}
                    onPress={close}
                  />
                ),
              }
          : null),
      })}
    >
      <Stack.Screen
        name="account"
        // The sheet's first page shows only its close button on iOS; "Account" still names it.
        // A title function returning null would fall back to showing the title text.
        options={{
          ...glassHeaderOptions(t("Account")),
          ...(Platform.OS === "ios" ? { headerTitle: "" } : null),
          contentStyle: { backgroundColor: native.groupedPage },
        }}
      />
      <Stack.Screen name="ai-data-sharing" options={glassHeaderOptions(t("AI data sharing"))} />
      <Stack.Screen name="archived-bots" options={{ title: t("Archived bots") }} />
      <Stack.Screen name="change-password" options={{ title: t("Change password") }} />
      <Stack.Screen name="models" options={glassHeaderOptions(t("Models"))} />
      <Stack.Screen name="voice" options={glassHeaderOptions(t("Voice"))} />
      <Stack.Screen name="integrations" options={glassHeaderOptions(t("Integrations"))} />
      <Stack.Screen
        name="integration-setup"
        options={glassHeaderOptions(t("Server integrations"))}
      />
    </Stack>
  );
}
