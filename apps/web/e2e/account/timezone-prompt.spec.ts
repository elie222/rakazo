import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Me } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, rpc, signup } from "../helpers/helpers";

test.use({ timezoneId: "Asia/Tokyo" });

async function accountZone(page: Page) {
  return (await rpc<Me>(page, "me", {})).timezone;
}

async function openWithAccountIn(page: Page, prefix: string, zone: string) {
  await signup(page, `${prefix}-${Date.now()}@rakazo.test`, "password12", "Traveller");
  await completeOnboarding(page);
  // A new account takes the browser's zone without asking.
  await expect.poll(() => accountZone(page)).toBe("Asia/Tokyo");
  await expect(page.getByTestId("timezone-prompt")).toHaveCount(0);
  await rpc(page, "preferences/update", { timezone: zone });
  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
}

test("asks once before moving the account to the device's zone, and remembers Keep", async ({
  page,
}, testInfo) => {
  await openWithAccountIn(page, "timezone-keep", "Europe/London");
  const prompt = page.getByTestId("timezone-prompt");
  await expect(prompt).toContainText("Switch to Tokyo time?");
  await captureScreenshot(page, testInfo, "timezone-prompt");

  await prompt.getByRole("button", { name: "Keep" }).click();
  await expect(prompt).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(prompt).toHaveCount(0);
  expect(await accountZone(page)).toBe("Europe/London");
});

test("Switch moves the account to the device's zone", async ({ page }) => {
  await openWithAccountIn(page, "timezone-switch", "Europe/London");
  const prompt = page.getByTestId("timezone-prompt");
  await prompt.getByRole("button", { name: "Switch" }).click();
  await expect(prompt).toHaveCount(0);
  await expect.poll(() => accountZone(page)).toBe("Asia/Tokyo");
});
