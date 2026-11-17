import { t } from "@lingui/core/macro";
import { deviceTimezoneStep, localTimezone, timeZonePlace } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { Alert } from "react-native";
import { rpc } from "./api";
import { errorText } from "./user-error";

const keptKey = (userId: string) => `rakazo.timezone-kept.${userId}`;

/** The device zone each account was kept for on this device, once read this launch. */
const kept = new Map<string, string | null>();
/** Accounts whose empty zone this launch already filled, so each poll does not send it again. */
const adopted = new Set<string>();
let asking = false;

async function keptZone(userId: string): Promise<string | null> {
  const known = kept.get(userId);
  if (known !== undefined) return known;
  const saved = await SecureStore.getItemAsync(keptKey(userId)).catch(() => null);
  kept.set(userId, saved);
  return saved;
}

/**
 * Keeps the account's timezone in step with this device. The inbox load calls it with the
 * zone its `me` brought, on launch and on every return to the foreground: an empty zone takes
 * the device's, and a different one asks once before moving. Keeping it is remembered for that
 * device zone, so the question comes back only when the device moves again. `isActive` says
 * whether the session the zone was read for is still the shown one.
 */
export async function checkDeviceTimezone(
  userId: string,
  accountZone: string | null | undefined,
  isActive: () => boolean,
): Promise<void> {
  // A server that predates timezones leaves it out.
  if (accountZone === undefined || asking) return;
  const device = localTimezone();
  const step = deviceTimezoneStep(device, accountZone, await keptZone(userId));
  if (step === "adopt") {
    if (adopted.has(userId)) return;
    adopted.add(userId);
    await rpc("preferences/adoptTimezone", { timezone: device });
    return;
  }
  if (step !== "ask" || asking || !isActive()) return;
  asking = true;
  const keep = () => {
    asking = false;
    kept.set(userId, device);
    void SecureStore.setItemAsync(keptKey(userId), device).catch(() => undefined);
  };
  const place = timeZonePlace(device);
  Alert.alert(t`Switch to ${place} time?`, undefined, [
    { text: t`Keep`, style: "cancel", onPress: keep },
    {
      text: t`Switch`,
      isPreferred: true,
      onPress: () => {
        rpc("preferences/update", { timezone: device })
          .catch((error: unknown) =>
            Alert.alert(errorText(error, t`Couldn't update your timezone`)),
          )
          .finally(() => {
            asking = false;
          });
      },
    },
  ]);
}

/** Test-only: forget what this launch read, adopted and asked. */
export function resetDeviceTimezoneForTests(): void {
  kept.clear();
  adopted.clear();
  asking = false;
}
