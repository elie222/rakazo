import type { Href, NativeStackNavigationProp } from "expo-router";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { closeSettingsSheet } from "./settings-sheet";

const FROM_SETTINGS = "settings";
// Leaving by the back button, a swipe or Cancel. Leaving a Space dismisses everything (POP_TO_TOP)
// to go Home, so it is not one, and opening something else keeps the page below it.
const BACK_ACTIONS = new Set(["GO_BACK", "POP"]);

/** Opens a root-stack page from settings so going back returns to settings. Android pushes it
 * over the settings page. On iOS a page over the sheet would be a second sheet, so the sheet
 * closes first and the page reopens it when it goes back (see `useBackToSettings`). */
export function openFromSettings(router: { push(href: Href): void }, href: Href): void {
  if (Platform.OS !== "ios") {
    router.push(href);
    return;
  }
  const { pathname, params } =
    typeof href === "string" ? { pathname: href, params: undefined } : href;
  closeSettingsSheet();
  router.push({ pathname, params: { ...params, from: FROM_SETTINGS } } as Href);
}

/** Reopens settings once the page goes back, when settings opened it. */
export function useBackToSettings(): void {
  const { from } = useLocalSearchParams<{ from?: string }>();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const router = useRouter();

  useEffect(() => {
    if (from !== FROM_SETTINGS) return;
    // Fires once the page is off the stack, so settings opens over what was below it.
    const unsubscribe = navigation.addListener("removed", (event) => {
      if (BACK_ACTIONS.has(event.data.action.type)) router.push("/account");
    });
    // The event comes after this cleanup runs, so the listener stays until the next microtask.
    return () => queueMicrotask(unsubscribe);
  }, [from, navigation, router]);
}
