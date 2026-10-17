import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("chat attachments use the upload limit from bootstrap", async ({ page }, testInfo) => {
  await signup(page, `upload-limit-${Date.now()}@rakazo.test`, "password12", "Upload Test");
  await completeOnboarding(page);
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.json.me.maxUploadSizeBytes = 1024 * 1024;
    await route.fulfill({ response, json: body });
  });
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByRole("combobox", { name: /Message/ })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: "large.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(1024 * 1024 + 1),
  });
  await expect(page.getByText("Skipped large.txt (over 1 MiB)", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove large.txt" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "configured-upload-limit");
});
