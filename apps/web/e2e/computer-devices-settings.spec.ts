import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("lists paired computers in settings and removes one", async ({ page }, testInfo) => {
  await signup(page, `computer-devices-${Date.now()}@rakazo.test`, "password12", "Computers");
  await completeOnboarding(page);
  const paired = await page.request.post("/api/devices/pair", {
    data: { name: "Fixture Mac", platform: "darwin" },
  });
  expect(paired.status()).toBe(201);

  const settings = await openUserSettings(page);
  const computers = settings.getByTestId("computer-devices");
  await expect(computers.getByText("Fixture Mac", { exact: true })).toBeVisible();
  await expect(computers.getByText("Offline", { exact: true })).toBeVisible();
  await computers.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "settings-computers");

  await computers.getByRole("button", { name: "Remove Fixture Mac" }).click();
  await expect(computers).toBeHidden();
});
