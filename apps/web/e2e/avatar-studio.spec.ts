import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

test("bot settings open Avatar Studio on the Bot tab", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-studio-${stamp}@rakazo.test`, "password12", "Avatar Studio");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();

  await settings.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByText("Avatar Studio", { exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Bot", exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Upload", exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Generate" })).toHaveCount(0);
  await expect(studio.getByTestId("avatar-studio-bot-tab")).toBeVisible();
  await expect(studio.getByText("Shape", { exact: true })).toBeVisible();
  await expect(studio.getByText("Color", { exact: true })).toBeVisible();

  await captureScreenshot(page, testInfo, "avatar-studio-bot-tab");
});

test("bot settings Upload tab can set a profile picture", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-upload-${stamp}@rakazo.test`, "password12", "Avatar Upload");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();

  await settings.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio).toBeVisible();
  await studio.getByTestId("avatar-studio-upload-tab").click();
  await expect(studio.getByTestId("avatar-studio-upload-dropzone")).toBeVisible();
  await expect(studio.getByText("Drag, drop, or paste an image")).toBeVisible();
  await expect(studio.getByRole("button", { name: "Choose file" })).toBeVisible();

  await captureScreenshot(page, testInfo, "avatar-studio-upload-tab");

  await studio.getByTestId("avatar-studio-file-input").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: PNG_1X1,
  });
  await expect(studio).toBeHidden();
  await expect(settings.locator(".rakazo-bot-avatar img")).toBeVisible();
});
