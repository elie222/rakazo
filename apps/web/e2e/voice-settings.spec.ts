import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("a self-hosted voice connection offers a separate transcription server", async ({
  page,
}, testInfo) => {
  // The screenshot never submits the form or contacts a speech server.
  const stamp = Date.now();
  await signup(page, `voice-stt-${stamp}@rakazo.test`, "password12", "Voice Transcription Preview");
  await completeOnboarding(page);
  await openUserSettings(page, "voice");
  const voice = page.getByTestId("voice-settings");
  await voice.getByRole("combobox", { name: "Provider" }).selectOption("openai-compatible");
  await voice.getByLabel("Server URL", { exact: true }).fill("http://127.0.0.1:8880/v1");
  await expect(voice.getByLabel("Transcription API key")).toHaveCount(0);
  await voice.getByLabel("Transcription server URL").fill("http://127.0.0.1:8881/v1");
  await expect(voice.getByLabel("Transcription API key")).toBeVisible();
  await voice.getByLabel("Transcription API key").scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "voice-self-hosted-transcription-server");
});
