import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("spaces stay invisible by default and chat creation requires approval", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `spaces-${stamp}@rakazo.test`, "password12", "Space Owner");
  await completeOnboarding(page);

  const sidebar = page.locator("aside").first();
  await expect(sidebar.getByText("Personal", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(1);
  await captureScreenshot(page, testInfo, "single-space-sidebar");

  await page.getByTitle("Create", { exact: true }).click();
  await page.getByRole("button", { name: "New space" }).click();
  const dialog = page.getByRole("dialog", { name: "New space" });
  await expect(dialog.getByLabel("Name")).toBeVisible();
  await dialog.getByLabel("Name").fill("Customer support");
  await captureScreenshot(page, testInfo, "new-space-dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("Create a space named Customer support");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Create space", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Always allow this tool" })).toHaveCount(0);
  await expect(sidebar.getByText("Customer support", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "create-space-chat-approval");
  await page.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(page.getByText("Created", { exact: true })).toBeVisible();

  await expect(sidebar.getByText("Personal", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Customer support", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  const supportSpace = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Customer support" });
  const supportSpaceGroup = await supportSpace.getAttribute("data-sidebar-group");
  const supportSpaceId = supportSpaceGroup?.split(":")[1];
  expect(supportSpaceId).toBeTruthy();
  await supportSpace.getByRole("button", { name: "Open Customer support" }).click();
  await page.waitForURL(/\/onboarding/);
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("rakazo:space-id")))
    .toBe(supportSpaceId);
  await completeOnboarding(page);

  await expect(sidebar.getByText("Personal", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("Customer support", { exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Chief/ })).toHaveCount(2);
  await captureScreenshot(page, testInfo, "spaces-sidebar");

  const personalSpace = sidebar
    .locator('[data-sidebar-group^="space:"]')
    .filter({ hasText: "Personal" });
  const personalSpaceGroup = await personalSpace.getAttribute("data-sidebar-group");
  const personalSpaceId = personalSpaceGroup?.split(":")[1];
  expect(personalSpaceId).toBeTruthy();
  await personalSpace.getByRole("button", { name: /^Chief/ }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("rakazo:space-id")))
    .toBe(personalSpaceId);
  await expect(sidebar.getByText("Customer support", { exact: true })).toBeVisible();
});
