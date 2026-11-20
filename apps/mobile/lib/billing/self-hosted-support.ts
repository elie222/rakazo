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

/** Asks a self-hosted server's user once per device; Settings keeps the way back. */
export async function offerSelfHostedSupportOnce(isActive: () => boolean): Promise<void> {
  if (asked || !selfHosted()) return;
  asked = true;
  if ((await SecureStore.getItemAsync(ASKED_KEY)) === "1") return;
  if (!isActive()) {
    asked = false;
    return;
  }
  await bestEffort("self-hosted support asked", SecureStore.setItemAsync(ASKED_KEY, "1"));
  showSelfHostedSupport();
}

/** Test-only: forget the in-process offer. */
export function resetSelfHostedSupportForTests(): void {
  asked = false;
}
