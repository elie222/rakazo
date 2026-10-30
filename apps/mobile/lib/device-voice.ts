import * as SecureStore from "expo-secure-store";
import { rpc } from "./api";

export const DEVICE_VOICE_KEY = "rakazo.device-voice";

/**
 * Until someone picks a voice, the phone's own is used unless a hosted voice is already set up,
 * so earlier installs keep the provider they connected. The first answer is kept, so later
 * replies don't wait on the server to decide.
 */
export async function loadDeviceVoiceEnabled(): Promise<boolean> {
  const stored = await SecureStore.getItemAsync(DEVICE_VOICE_KEY);
  if (stored) return stored === "1";
  let ready: boolean;
  try {
    ready = (await rpc("voice/status", { scope: "account" })).ready;
  } catch {
    return true;
  }
  await saveDeviceVoiceEnabled(!ready).catch(() => undefined);
  return !ready;
}

export async function saveDeviceVoiceEnabled(on: boolean): Promise<void> {
  await SecureStore.setItemAsync(DEVICE_VOICE_KEY, on ? "1" : "0");
}
