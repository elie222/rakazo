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

/** The explicit local-only choice, without probing a provider or storing an inferred default. */
export async function loadDeviceVoicePreference(): Promise<boolean | undefined> {
  const stored = await SecureStore.getItemAsync(DEVICE_VOICE_KEY);
  return stored ? stored === "1" : undefined;
}

/**
 * An explicit device-only choice always wins. Otherwise use the current effective hosted voice,
 * including a bot override, without turning a temporary missing connection into a saved preference.
 */
export async function loadDeviceVoiceEnabled(
  botId?: string,
  requestContext?: ApiRequestContext,
  loadVoiceStatus?: () => Promise<{ ready: boolean }>,
): Promise<boolean> {
  const seen = choices;
  const stored = await loadDeviceVoicePreference();
  if (stored !== undefined) return stored;
  let ready: boolean;
  try {
    ready = (
      await (loadVoiceStatus
        ? loadVoiceStatus()
        : rpc(
            "voice/status",
            botId ? { botId } : { scope: "account" },
            requestContext ? { requestContext } : undefined,
          ))
    ).ready;
  } catch {
    return true;
  }
  if (choices !== seen) return loadDeviceVoiceEnabled(botId, requestContext, loadVoiceStatus);
  return !ready;
}

export function saveDeviceVoiceEnabled(on: boolean): Promise<void> {
  choices += 1;
  return write(on);
}
