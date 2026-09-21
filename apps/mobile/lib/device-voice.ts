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

export async function saveDeviceVoiceEnabled(on: boolean): Promise<void> {
  try {
    if (on) await SecureStore.setItemAsync(DEVICE_VOICE_KEY, "1");
    else await SecureStore.deleteItemAsync(DEVICE_VOICE_KEY);
  } catch {
    // SecureStore unavailable in some test / web hosts.
  }
}
