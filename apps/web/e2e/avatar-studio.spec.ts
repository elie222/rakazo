import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

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

  const defaultLook = studio.getByTestId("avatar-studio-default");
  const wedge = studio.getByRole("button", { name: "wedge", exact: true });
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");

  await wedge.click();
  await expect(wedge).toHaveAttribute("aria-pressed", "true");
  await expect(defaultLook).toHaveAttribute("aria-pressed", "false");
  await expect(studio.locator(".rakazo-bot-avatar-visor")).toHaveCount(0);

  await defaultLook.click();
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");
  await expect(studio.locator(".rakazo-bot-avatar-visor")).toHaveCount(1);
  await expect(studio.locator(".rakazo-bot-avatar-eyes").first()).toBeVisible();

  await studio.getByRole("button", { name: "Color #EAB308" }).click();
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");

  await wedge.click();
  await studio.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");
  await expect(studio.locator(".rakazo-bot-avatar-visor")).toHaveCount(1);

  await captureScreenshot(page, testInfo, "avatar-studio-bot-tab");
});
