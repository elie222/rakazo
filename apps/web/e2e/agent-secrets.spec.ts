import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("manages Space agent secrets without rendering stored values", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `agent-secrets-${stamp}@rakazo.test`, "password12", "Secret Owner");
  await page.waitForURL(/\/(app|onboarding)/, { timeout: 20_000 });
  await page.goto("/onboarding");
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Secrets", exact: true }).click();

  const overlay = page.getByTestId("agent-secrets-overlay");
  await expect(overlay).toBeVisible();
  await overlay.getByLabel("Name").fill("AUDIENTI_API_KEY");
  await overlay.getByLabel("Secret value").fill("audienti_test_private_value");
  await overlay.getByRole("button", { name: "Save secret" }).click();

  await expect(overlay.getByText("AUDIENTI_API_KEY", { exact: true })).toBeVisible();
  await expect(overlay.getByLabel("Secret value")).toHaveValue("");
  await expect(overlay).not.toContainText("audienti_test_private_value");
  await captureScreenshot(page, testInfo, "agent-secrets");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole("button", { name: "Save secret" })).toBeVisible();
  await captureScreenshot(page, testInfo, "agent-secrets-mobile");
  await page.setViewportSize({ width: 1280, height: 720 });

  await overlay.getByRole("button", { name: "Close secret settings" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Secrets", exact: true }).click();
  await expect(page.getByTestId("agent-secrets-overlay")).toContainText("AUDIENTI_API_KEY");

  await page.getByRole("button", { name: "Delete AUDIENTI_API_KEY" }).click();
  await page.getByRole("button", { name: "Confirm delete AUDIENTI_API_KEY" }).click();
  await expect(page.getByText("AUDIENTI_API_KEY", { exact: true })).toHaveCount(0);
});
