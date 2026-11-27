import { bestEffort } from "@rakazo/logging/best-effort";
import { Linking } from "react-native";

/**
 * Opens a link outside the app. The system can refuse even a web page (no default browser,
 * restrictions, an app switch in progress), so a web page then opens in the in-app browser.
 * Only a web address reaches the opener: another scheme can start an app or a privileged action.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  const opened = await bestEffort(
    "open link",
    // The executor turns an opener that throws synchronously into a rejection.
    new Promise((resolve) => resolve(Linking.openURL(url))).then(() => true),
  );
  if (opened) return;
  await bestEffort(
    "open link in browser",
    import("expo-web-browser").then((browser) => browser.openBrowserAsync(url)),
  );
}
