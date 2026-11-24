import type { Href, NativeStackNavigationProp } from "expo-router";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { openFromSettingsSheet } from "./settings-sheet";

type SettingsDestination =
  | { pathname: "/artifacts" | "/board"; params?: never }
  | { pathname: "/space-members"; params: { spaceId: string } };

type SettingsPage = "/account" | "/spaces";

export function openFromSettings(
  router: { push(href: Href): void },
  destination: SettingsDestination,
  fromSettings: SettingsPage,
): void {
  // iOS presents root screens opened above the Settings sheet as another sheet.
  if (Platform.OS === "ios") {
    openFromSettingsSheet(router, {
      ...destination,
      params: { ...destination.params, fromSettings },
    });
  } else {
    router.push(destination);
  }
}

export function useBackToSettings(): void {
  const { fromSettings } = useLocalSearchParams<{ fromSettings?: string }>();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS !== "ios" || (fromSettings !== "/account" && fromSettings !== "/spaces"))
      return;

    // Expo Router reports removals in a layout effect, before this passive effect unsubscribes.
    return navigation.addListener("removed", ({ data: { action } }) => {
      if (action.type === "GO_BACK" || action.type === "POP") {
        router.push(fromSettings, { withAnchor: true });
      }
    });
  }, [fromSettings, navigation, router]);
}
