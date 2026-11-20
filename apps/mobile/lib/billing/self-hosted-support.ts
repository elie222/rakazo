import { t } from "@lingui/core/macro";
import { bestEffort } from "@rakazo/logging/best-effort";
import * as SecureStore from "expo-secure-store";
import { Alert } from "react-native";
import { currentApiBase } from "../api/api";
import { usesCustomApiBase } from "../api/endpoint";
import { openExternalUrl } from "../platform/open-url";

const ASKED_KEY = "rakazo.self-hosted-support-asked";
// Redirects on the website, so the payment pages can change without an app release.
const SUPPORTER_URL = "https://rakazo.com/supporter";
const PRIORITY_SUPPORT_URL = "https://rakazo.com/priority-support";

let asked = false;

export function selfHosted(): boolean {
  return usesCustomApiBase(currentApiBase());
}

export function showSelfHostedSupport(): void {
  Alert.alert(
    t`Support Rakazo`,
    t`Rakazo is free to self-host. If you'd like to support it, subscribers can email support@rakazo.com for help.`,
    [
      { text: t`Support for $25 / month`, onPress: () => void openExternalUrl(SUPPORTER_URL) },
      {
        text: t`Priority support for $100 / month`,
        onPress: () => void openExternalUrl(PRIORITY_SUPPORT_URL),
      },
      { text: t`Not now`, style: "cancel" },
    ],
  );
}

/**
 * Asks a self-hosted server's user once per device; Settings keeps the way back. Resolves true
 * when it asked. A failed read or write leaves the offer for a later inbox visit.
 */
export async function offerSelfHostedSupportOnce(isActive: () => boolean): Promise<boolean> {
  if (asked || !selfHosted()) return false;
  asked = true;
  const stored = await bestEffort(
    "self-hosted support read",
    SecureStore.getItemAsync(ASKED_KEY).then((value) => value ?? ""),
  );
  if (stored === "1") return false;
  const saved =
    stored !== undefined &&
    isActive() &&
    (await bestEffort(
      "self-hosted support save",
      SecureStore.setItemAsync(ASKED_KEY, "1").then(() => true),
    ));
  if (!saved) {
    asked = false;
    return false;
  }
  if (!isActive()) {
    asked = false;
    await bestEffort("self-hosted support undo", SecureStore.deleteItemAsync(ASKED_KEY));
    return false;
  }
  showSelfHostedSupport();
  return true;
}

/** Test-only: forget the in-process offer. */
export function resetSelfHostedSupportForTests(): void {
  asked = false;
}
