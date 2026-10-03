import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ComputerStatus } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function openComputerPanel(page: Page) {
  await page.getByTitle("Agent computer").waitFor({ state: "visible" });
  if ((await page.getByTestId("side-panel").getAttribute("data-panel")) !== "computer") {
    await page.getByTitle("Agent computer").click();
  }
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "computer");
}

/** The selector stays hidden until Advanced on the computer panel is opened. */
async function openKeepAwake(page: Page) {
  await openComputerPanel(page);
  const advanced = page.getByTestId("computer-advanced");
  await expect(advanced).toBeVisible();
  const policy = page.getByRole("combobox", { name: "Keep awake" });
  await expect(policy).toBeHidden();
  await advanced.locator("summary").click();
  await expect(policy).toBeVisible();
  return policy;
}

test("computer sleep policy persists after reload", async ({ page }, testInfo) => {
  await signup(page, `computer-awake-${Date.now()}@rakazo.test`, "password12", "Computer Settings");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const policy = await openKeepAwake(page);
  await expect(policy).toHaveValue("automatic");
  await policy.selectOption("always");
  await expect
    .poll(async () => (await rpc<ComputerStatus>(page, "computer/status", { botId })).sleepPolicy)
    .toBe("always");
  await page.reload();
  const reloaded = await openKeepAwake(page);
  await expect(reloaded).toHaveValue("always");
  await reloaded.selectOption("app_open");
  await expect
    .poll(async () => (await rpc<ComputerStatus>(page, "computer/status", { botId })).sleepPolicy)
    .toBe("app_open");
  await rpc(page, "computer/appHeartbeat", {});
  await expect(reloaded).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-keep-awake");
});
