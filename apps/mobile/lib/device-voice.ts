import * as SecureStore from "expo-secure-store";
import type { ApiRequestContext } from "./api";
import { rpc } from "./api";

export const DEVICE_VOICE_KEY = "rakazo.device-voice";

// Counts explicit choices, so a default worked out meanwhile never overwrites one.
let choices = 0;
let lastWrite: Promise<unknown> = Promise.resolve();

function write(on: boolean): Promise<void> {
  const next = lastWrite.then(() => SecureStore.setItemAsync(DEVICE_VOICE_KEY, on ? "1" : "0"));
  lastWrite = next.catch(() => undefined);
  return next;
}

/**
 * An explicit device-only choice always wins. Otherwise use the current effective hosted voice,
 * including a bot override, without turning a temporary missing connection into a saved preference.
 */
export async function loadDeviceVoiceEnabled(
  botId?: string,
  requestContext?: ApiRequestContext,
): Promise<boolean> {
  const seen = choices;
  const stored = await SecureStore.getItemAsync(DEVICE_VOICE_KEY);
  if (stored) return stored === "1";
  let ready: boolean;
  try {
    ready = (
      await rpc(
        "voice/status",
        botId ? { botId } : { scope: "account" },
        requestContext ? { requestContext } : undefined,
      )
    ).ready;
  } catch {
    return true;
  }
  if (choices !== seen) return loadDeviceVoiceEnabled(botId, requestContext);
  return !ready;
}

export function saveDeviceVoiceEnabled(on: boolean): Promise<void> {
  choices += 1;
  return write(on);
}
