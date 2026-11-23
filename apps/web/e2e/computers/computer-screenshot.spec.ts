import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanel, signup } from "../helpers/helpers";

test("the full-window computer saves a screenshot of the bot's screen", async ({
  page,
}, testInfo) => {
  await signup(page, `screenshot-${Date.now()}@rakazo.test`, "password12", "Shots");
  await completeOnboarding(page);

  await openBotPanel(page);
  await page.getByTestId("side-panel").getByTestId("computer-preview-open").click();
  const chrome = page.getByTestId("computer-chrome");
  await chrome.getByRole("button", { name: "Take control", exact: true }).click();
  const save = chrome.getByRole("button", { name: "Save screenshot", exact: true });
  await expect(save).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-save-screenshot");

  const download = page.waitForEvent("download");
  await save.click();
  expect((await download).suggestedFilename()).toMatch(/^screen-[\d-]+\.(png|jpg|webp)$/);
  await expect(chrome.getByRole("alert")).toHaveCount(0);
});
