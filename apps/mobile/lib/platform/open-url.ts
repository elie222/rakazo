import { bestEffort } from "@rakazo/logging/best-effort";
import { Linking } from "react-native";

/**
 * Opens a link outside the app. The system can refuse even a web page (no default browser,
 * restrictions, an app switch in progress), so a web page then opens in the in-app browser.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const opened = await bestEffort(
    "open link",
    // The executor turns an opener that throws synchronously into a rejection.
    new Promise((resolve) => resolve(Linking.openURL(url))).then(() => true),
  );
  if (opened || !/^https?:\/\//i.test(url)) return;
  await bestEffort(
    "open link in browser",
    import("expo-web-browser").then((browser) => browser.openBrowserAsync(url)),
  );
}
