import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("set selection preserves legacy, shapes and photos and persists an explicit switch on reload", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const theme of ["dark", "light"]) {
    await page.goto(`/e2e/fixtures/avatar-sets.html?theme=${theme}`);
    await page.evaluate(() => localStorage.removeItem("avatar-set-settings-fixture"));
    await page.reload();
    const legacy = page.getByTestId("legacy-sample"),
      photo = page.getByTestId("photo-sample"),
      shape = page.getByTestId("original-shape-sample");
    await expect(legacy.locator(".rakazo-organic-avatar")).toBeVisible();
    await expect(shape.locator(".bot-character-eyes")).toBeVisible();
    await expect(photo.locator("img")).toBeVisible();
    await legacy.getByTestId("avatar-studio-trigger").click();
    const studio = page.getByTestId("avatar-studio");
    await expect(studio.getByRole("tab", { name: "Original", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await studio.getByRole("tab", { name: "Rakazo", exact: true }).click();
    await expect(studio.locator(".rakazo-logo-avatar").first()).toBeVisible();
    await captureScreenshot(page, testInfo, `avatar-set-studio-${theme}`);
    await studio.getByRole("button", { name: "Done", exact: true }).click();
    await page.reload();
    await expect(legacy.locator(".rakazo-logo-avatar")).toBeVisible();
    await expect(shape.locator(".bot-character-eyes")).toBeVisible();
    await expect(photo.locator("img")).toBeVisible();
    await legacy.getByTestId("avatar-studio-trigger").click();
    await expect(studio.getByRole("tab", { name: "Rakazo", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await studio.getByRole("tab", { name: "Original", exact: true }).click();
    await studio.getByRole("button", { name: "Done", exact: true }).click();
    await expect(legacy.locator(".rakazo-organic-avatar")).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("new-bot dialog defaults to Rakazo and submits its explicit set", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/avatar-sets.html");
  await page.getByRole("button", { name: "New bot", exact: true }).click();
  const dialog = page.getByTestId("create-bot-dialog");
  await expect(dialog.getByRole("tab", { name: "Rakazo", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.locator(".rakazo-logo-avatar").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "create-bot-default-rakazo");
  await dialog.getByPlaceholder("Name your Bot").fill("New example");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const created = JSON.parse((await page.getByTestId("created-bot").textContent()) || "{}");
  expect(created).toMatchObject({ name: "New example", avatarSet: "rakazo" });
  expect(created).not.toHaveProperty("avatarFamily");
});
