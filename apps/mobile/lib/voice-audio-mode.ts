import { Platform } from "react-native";

/** Keep iOS playback compatible with the recognizer's play-and-record session. */
export async function configureVoiceAudio(): Promise<void> {
  const { setAudioModeAsync } = await import("expo-audio");
  await setAudioModeAsync({
    allowsRecording: Platform.OS === "ios",
    playsInSilentMode: true,
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  });
}
