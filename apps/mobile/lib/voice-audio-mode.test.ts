import { setAudioModeAsync } from "expo-audio";
import { Platform } from "react-native";
import { afterEach, expect, it, vi } from "vitest";
import { configureVoiceAudio } from "./voice-audio-mode";

vi.mock("expo-audio", () => ({ setAudioModeAsync: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
afterEach(() => {
  Platform.OS = "ios";
  vi.clearAllMocks();
});

it("preserves iOS microphone access and speaker routing during playback", async () => {
  await configureVoiceAudio();
  expect(setAudioModeAsync).toHaveBeenCalledWith({
    allowsRecording: true,
    playsInSilentMode: true,
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  });
});

it("keeps Android playback out of recording mode", async () => {
  Platform.OS = "android";
  await configureVoiceAudio();
  expect(setAudioModeAsync).toHaveBeenCalledWith(
    expect.objectContaining({ allowsRecording: false }),
  );
});
