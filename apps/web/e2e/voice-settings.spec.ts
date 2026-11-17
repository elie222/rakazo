import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  openBotSettings,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("a self-hosted voice connection offers a separate transcription server", async ({
  page,
}, testInfo) => {
  // The screenshot never submits the form or contacts a speech server.
  const stamp = Date.now();
  await signup(page, `voice-stt-${stamp}@rakazo.test`, "password12", "Voice Transcription Preview");
  await completeOnboarding(page);
  await openUserSettings(page, "voice");
  const voice = page.getByTestId("voice-settings");
  await chooseOption(voice.getByRole("combobox", { name: "Provider" }), "Self-hosted");
  await voice.getByLabel("Server URL", { exact: true }).fill("http://127.0.0.1:8880/v1");
  await expect(voice.getByLabel("Transcription API key")).toHaveCount(0);
  await voice.getByLabel("Transcription server URL").fill("http://127.0.0.1:8881/v1");
  await expect(voice.getByLabel("Transcription API key")).toBeVisible();
  await voice.getByLabel("Transcription API key").scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "voice-self-hosted-transcription-server");
});

test("a bot can choose its own voice and preview it without changing the default", async ({
  page,
}, testInfo) => {
  await signup(page, `bot-voice-${Date.now()}@rakazo.test`, "password12", "Bot Voice");
  await completeOnboarding(page);
  await rpc(page, "voice/connect", { provider: "scripted", apiKey: "fake-bot-voice-key" });
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = new URL(page.url()).pathname.split("/").at(-1)!;
  await openBotSettings(page);
  const settings = page.getByTestId("bot-voice-settings");
  const provider = settings.getByRole("combobox", { name: "Voice provider", exact: true });
  const voice = settings.getByRole("combobox", { name: "Voice", exact: true });
  await expect(provider).toContainText("Default (Scripted)");
  await chooseOption(provider, "Scripted");
  await expect(provider).toBeEnabled();
  await chooseOption(voice, "Scripted");
  await expect(voice).toBeEnabled();
  expect(await rpc(page, "bots/get", { botId })).toMatchObject({
    voiceProvider: "scripted",
    voiceId: "alloy-test",
  });
  await captureScreenshot(page, testInfo, "bot-voice-personality");
  const spoken = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/voice/speak") && response.request().method() === "POST",
  );
  await settings.getByRole("button", { name: "Hear a sample" }).click();
  const response = await spoken;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({ botId });
  expect(await rpc(page, "voice/status", {})).toMatchObject({
    provider: "scripted",
    voiceId: "alloy-test",
  });
  await chooseOption(provider, "Default (Scripted)");
  await expect(provider).toBeEnabled();
  expect(await rpc(page, "bots/get", { botId })).toMatchObject({
    voiceProvider: null,
    voiceId: null,
  });
});
