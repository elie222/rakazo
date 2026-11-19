import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
} from "../helpers/helpers";

test("never asks for a GitHub star after repeated messages", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signup(page, `star-prompt-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  await rpc(page, "onboarding/dismissFocus", { botId: activeBotId(page) });
  await page.evaluate(() => localStorage.setItem("rakazo.githubStarPrompt.sent", "5"));

  const composer = page.getByRole("combobox", { name: /Message/ });
  const transcript = page.getByTestId("transcript");
  for (let index = 1; index <= 7; index++) {
    const text = `Message ${index}`;
    await composer.fill(text);
    await composer.press("Enter");
    await expect(transcript.getByText(text, { exact: true })).toBeVisible();
  }

  const prompt = page.getByRole("complementary", { name: "Star on GitHub" });
  await expect(prompt).toHaveCount(0);
  await captureScreenshot(page, testInfo, "chat-without-star-prompt");
  await page.reload();
  await composer.fill("And tomorrow?");
  await composer.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("And tomorrow?", { exact: true }),
  ).toBeVisible();
  await expect(prompt).toBeHidden();
});
