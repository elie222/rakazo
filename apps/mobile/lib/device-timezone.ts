import { t } from "@lingui/core/macro";
import type { KeptTimezone } from "@rakazo/core";
import { deviceTimezoneStep, parseKeptTimezone, timeZonePlace } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { Alert } from "react-native";
import { rpc } from "./api";
import { deviceTimeZone } from "./routine";
import { errorText } from "./user-error";

const keptKey = (userId: string) => `rakazo.timezone-kept.${userId}`;

/** Each account's Keep on this device, once read this launch. */
const kept = new Map<string, KeptTimezone | null>();
/** Accounts whose empty zone this launch already filled, so each poll does not send it again. */
const adopted = new Set<string>();
/** The account whose question is on screen. */
let asking: string | null = null;

function parseStored(raw: string | null): KeptTimezone | null {
  try {
    return raw ? parseKeptTimezone(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

async function keptZone(userId: string): Promise<KeptTimezone | null> {
  const known = kept.get(userId);
  if (known !== undefined) return known;
  const saved = parseStored(await SecureStore.getItemAsync(keptKey(userId)).catch(() => null));
  // A Keep answered while this read was out is newer than what it read.
  if (!kept.has(userId)) kept.set(userId, saved);
  return kept.get(userId) ?? null;
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
  if (accountZone === undefined || asking === userId) return;
  // A runtime that names no zone is not a reading of UTC.
  const device = deviceTimeZone();
  if (!device) return;
  const step = deviceTimezoneStep(device, accountZone, await keptZone(userId));
  // The read above can outlive the session: a write now would land on the next account.
  if (step === null || asking === userId || !isActive()) return;
  if (step === "adopt") {
    if (adopted.has(userId)) return;
    adopted.add(userId);
    try {
      await rpc("preferences/adoptTimezone", { timezone: device });
    } catch (error) {
      // The next load tries again.
      adopted.delete(userId);
      throw error;
    }
    return;
  }
  if (accountZone === null) return;
  // One question at a time; another account's load asks once this one is answered.
  if (asking !== null) return;
  asking = userId;
  const answer: KeptTimezone = { device, account: accountZone };
  const keep = () => {
    asking = null;
    kept.set(userId, answer);
    void SecureStore.setItemAsync(keptKey(userId), JSON.stringify(answer)).catch(() => undefined);
  };
  const place = timeZonePlace(device);
  Alert.alert(t`Switch to ${place} time?`, undefined, [
    { text: t`Keep`, style: "cancel", onPress: keep },
    {
      text: t`Switch`,
      isPreferred: true,
      onPress: () => {
        if (!isActive()) {
          asking = null;
          return;
        }
        rpc("preferences/update", { timezone: device })
          // A load that read the zone before this save must not ask again; kept for this launch only.
          .then(() => void kept.set(userId, answer))
          .catch((error: unknown) =>
            Alert.alert(errorText(error, t`Couldn't update your timezone`)),
          )
          .finally(() => {
            asking = null;
          });
      },
    },
  ]);
}

/** Test-only: forget what this launch read, adopted and asked. */
export function resetDeviceTimezoneForTests(): void {
  kept.clear();
  adopted.clear();
  asking = null;
}
