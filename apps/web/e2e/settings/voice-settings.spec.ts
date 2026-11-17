import { expect, test } from "@playwright/test";
import { AI_DISCLOSURE_VERSION, AI_PRIVACY_URL } from "@rakazo/contracts";
import {
  captureScreenshot,
  chooseOption,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "../helpers/helpers";

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

test("read-aloud asks before sharing voice data and cancel sends no speech", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(
    page,
    `voice-consent-${stamp}@rakazo.test`,
    "password12",
    "Voice Disclosure Preview",
  );
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await composer.fill(`voice-consent-${stamp}`);
  await composer.press("Enter");
  const reply = page
    .getByTestId("message-bot-bubble")
    .filter({ hasText: `i handled: voice-consent-${stamp}` });
  await expect(reply).toBeVisible({ timeout: 20_000 });
  await rpc(page, "voice/connect", { provider: "scripted", apiKey: "fake-voice-key" });
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByTestId("call-button")).toHaveAttribute("data-voice-ready", "");
  const recipient = {
    key: "voice-fixture",
    name: "Example speech server",
    detail: "https://speech.example.test",
    use: "voice",
    allowed: false,
  };
  await page.route("**/rpc/aiConsent/status", (route) =>
    route.fulfill({
      json: {
        json: { scope: "account-space", version: AI_DISCLOSURE_VERSION, recipients: [recipient] },
      },
    }),
  );
  let speechRequests = 0;
  let grants = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/voice/speak") speechRequests += 1;
    if (new URL(request.url()).pathname === "/rpc/aiConsent/allow") grants += 1;
  });
  const speak = reply.getByRole("button", { name: "Speak this reply" });
  await expect(speak).toBeEnabled();
  await speak.click();
  const disclosure = page.getByRole("alertdialog");
  await expect(
    disclosure.getByRole("heading", { name: "Share voice data with Example speech server?" }),
  ).toBeVisible();
  await expect(disclosure.getByRole("link", { name: "Privacy policy" })).toHaveAttribute(
    "href",
    AI_PRIVACY_URL,
  );
  expect(speechRequests).toBe(0);
  expect(grants).toBe(0);
  await captureScreenshot(page, testInfo, "voice-data-sharing-disclosure");
  await disclosure.getByRole("button", { name: "Cancel" }).click();
  await expect(disclosure).toBeHidden();
  await expect(speak).toBeEnabled();
  expect(speechRequests).toBe(0);
  expect(grants).toBe(0);
});
