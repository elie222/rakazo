import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("teach a task records interaction and saves a draft", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `teach-${stamp}@rakazo.test`, "password12", "Teach");
  await completeOnboarding(page);

  await page.getByTitle("Agent computer").click();
  const sidePanel = page.getByTestId("side-panel");
  await expect(sidePanel).toHaveAttribute("data-panel", "computer");
  await expect(sidePanel.getByText("Teach a task")).toHaveCount(0);
  await expect(sidePanel.getByTestId("teach-start-button")).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Reset computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Update computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Take control" })).toHaveCount(0);
  await expect(sidePanel.getByTestId("computer-more-button")).toHaveCount(0);
  await expect(sidePanel.getByTestId("computer-preview")).toBeVisible();
  await captureScreenshot(page, testInfo, "teach-sidepanel-simple");

  const preview = sidePanel.getByTestId("computer-preview");
  await preview.hover();
  const openButton = sidePanel.getByTestId("computer-preview-open");
  await expect(openButton).toBeVisible();
  await expect(openButton.getByText("Open", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "teach-sidepanel-open-hover");

  await openButton.click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  const chrome = page.getByTestId("computer-chrome");
  await expect(chrome.getByText("You have control", { exact: true })).toBeVisible();
  await expect(chrome.getByRole("button", { name: "Release", exact: true })).toBeVisible();
  await expect(chrome.getByTestId("teach-start-button")).toBeVisible();
  const more = chrome.getByTestId("computer-more-button");
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    await expect(page.getByTestId("computer-more-menu")).toBeVisible();
    // Close via the More control again (Escape must not close the computer overlay).
    await more.click();
    await expect(page.getByTestId("computer-more-menu")).toHaveCount(0);
  }
  await captureScreenshot(page, testInfo, "teach-computer-chrome");

  const teachStart = chrome.getByTestId("teach-start-button");
  await expect(teachStart).toBeEnabled();
  await teachStart.click();
  await page.getByTestId("teach-goal-input").fill("Export weekly CRM list");
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByTestId("teach-recording-overlay")).toBeVisible();
  await expect(page.getByTestId("teach-capture-overlay")).toBeVisible();
  await page.getByTestId("teach-capture-overlay").click({ position: { x: 200, y: 200 } });
  await page.keyboard.type("demo");
  await page.getByTestId("teach-stop-overlay").click();
  await expect(page.getByTestId("skill-draft-card")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("skill-draft-card").getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByTestId("skill-draft-card").getByRole("button", { name: "Saved" }),
  ).toBeVisible({ timeout: 10_000 });
});
