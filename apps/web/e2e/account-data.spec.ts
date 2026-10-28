import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("account settings offer exporting and importing account data", async ({ page }, testInfo) => {
  await signup(page, `account-data-${Date.now()}@rakazo.test`, "password12", "Data QA");
  await completeOnboarding(page);
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const data = page.getByTestId("user-settings").getByTestId("account-data");
  await expect(data.getByRole("button", { name: "Export data", exact: true })).toBeEnabled();
  await expect(data.getByRole("button", { name: "Import data", exact: true })).toBeEnabled();
  await data.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await captureScreenshot(page, testInfo, "account-data-settings");
});
