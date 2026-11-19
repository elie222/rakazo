import { t } from "@lingui/core/macro";
import type * as ExpoSpeech from "expo-speech";

export async function loadExpoSpeech(): Promise<typeof ExpoSpeech> {
  let Speech: Partial<typeof ExpoSpeech>;
  // Load the optional native engine only when this platform actually needs device speech.
  try {
    Speech = await import("expo-speech");
  } catch (error) {
    throw error instanceof Error ? error : new Error(t`Could not play that clip.`);
  }
  if (typeof Speech.speak !== "function" || typeof Speech.stop !== "function") {
    throw new Error(t`Could not play that clip.`);
  }
  return Speech as typeof ExpoSpeech;
}

export function speakOneUtterance(
  Speech: typeof ExpoSpeech,
  text: string,
  voice?: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Only offline voices are assigned; without one, use the engine default.
    Speech.speak(text, {
      ...(voice ? { voice } : {}),
      onDone: () => resolve(),
      // Speech.stop() reports onStopped, not onDone.
      onStopped: () => resolve(),
      onError: (error) => reject(error instanceof Error ? error : new Error(String(error))),
    });
  });
}
