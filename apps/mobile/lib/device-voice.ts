import * as SecureStore from "expo-secure-store";

/**
 * Free, offline text-to-speech using the phone's own OS voice (Android's
 * TextToSpeech engine, or iOS's AVSpeechSynthesizer) instead of a hosted,
 * billed voice provider. This is a per-device preference, not a server-side
 * voice credential: when it's on, `speakText` speaks locally and never
 * contacts `/api/voice/speak` at all.
 */
export const DEVICE_VOICE_KEY = "rakazo.device-voice";

export async function loadDeviceVoiceEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(DEVICE_VOICE_KEY)) === "1";
  } catch {
    return false;
  }
}

/**
 * Persists the preference and reports whether it actually landed. This
 * controls whether speech text leaves the phone at all, so a caller that
 * shows an optimistic toggle must roll it back on `false` — silently
 * swallowing a write failure here would let the UI claim "on-device" while
 * `speakText` still reads the old (unsaved) value and routes to a hosted
 * provider.
 */
export async function saveDeviceVoiceEnabled(on: boolean): Promise<boolean> {
  try {
    if (on) await SecureStore.setItemAsync(DEVICE_VOICE_KEY, "1");
    else await SecureStore.deleteItemAsync(DEVICE_VOICE_KEY);
    return true;
  } catch {
    return false;
  }
}
