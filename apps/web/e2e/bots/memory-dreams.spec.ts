import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotMemory, signup } from "../helpers/helpers";

test("memory dreams: empty state, a dream now, and paused while memory is off", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `memory-dreams-${stamp}@rakazo.test`, "password12", "Memory Dreams");
  await completeOnboarding(page, testInfo);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await openBotMemory(page);
  await page.getByTestId("bot-memory-tab-dreams").click();
  await expect(page.getByTestId("bot-dreams-empty")).toBeVisible();
  await expect(
    page.getByText("Between conversations, the bot rewrites its notes from your own words."),
  ).toBeVisible();
  await expect(page.getByTestId("bot-dream-now")).toBeEnabled();
  await captureScreenshot(page, testInfo, "memory-dreams-empty");

  // Dreaming now records a run at once; its row reads as working while it starts.
  await page.getByTestId("bot-dream-now").click();
  await expect(page.getByTestId("bot-dreams")).toContainText("Working");
  await captureScreenshot(page, testInfo, "memory-dreams-record");

  // Turning both banks off pauses dreams instead of leaving a dead control.
  await page.getByTestId("bot-memory-tab-user").click();
  await page.getByRole("switch", { name: "Use shared notes" }).click();
  await page.getByTestId("bot-memory-tab-bot").click();
  await page.getByRole("switch", { name: "Use its own memory" }).click();
  await page.getByTestId("bot-memory-tab-dreams").click();
  await expect(page.getByTestId("bot-dreams-paused")).toBeVisible();
  await expect(page.getByTestId("bot-dream-now")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "memory-dreams-paused");
});
