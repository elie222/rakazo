import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("a failed overlay chunk keeps the shell and the draft, and Refresh loads it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `overlay-load-${stamp}@rakazo.test`, "password12", "Overlay Load");
  await completeOnboarding(page);

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("Keep this draft");

  const pluginsChunk = /\/pages\/PluginsOverlay\.tsx/;
  await page.route(pluginsChunk, (route) => route.fulfill({ status: 404 }));
  await page.getByText("Integrations", { exact: true }).click();

  const failed = page.getByRole("alertdialog", { name: "Could not load" });
  await expect(failed).toBeVisible();
  await captureScreenshot(page, testInfo, "overlay-load-failed");

  await failed.getByRole("button", { name: "Close", exact: true }).click();
  await expect(failed).toHaveCount(0);
  await expect(composer).toHaveValue("Keep this draft");

  await page.unroute(pluginsChunk);
  await page.getByText("Integrations", { exact: true }).click();
  await failed.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Integrations", { exact: true }).click();
  await expect(page.getByPlaceholder("Search apps")).toBeVisible();
});

test("a failed page chunk shows Refresh instead of a blank app", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `page-load-${stamp}@rakazo.test`, "password12", "Page Load");
  await completeOnboarding(page);

  const artifactsChunk = /\/pages\/Artifacts\.tsx/;
  await page.route(artifactsChunk, (route) => route.fulfill({ status: 404 }));
  await page.goto("/app/artifacts");

  await expect(page.getByText("Something went wrong. Try again.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "page-load-failed");

  await page.unroute(artifactsChunk);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
  await expect(page.getByText("Something went wrong. Try again.", { exact: true })).toHaveCount(0);
});

for (const [failing, intact] of [
  ["ScratchpadSection", "bot-knowledge"],
  ["KnowledgeSection", "bot-scratchpad"],
] as const) {
  test(`a failed ${failing} chunk keeps the rest of the bot settings panel`, async ({ page }) => {
    const stamp = Date.now();
    await signup(page, `section-load-${stamp}@rakazo.test`, "password12", "Section Load");
    await completeOnboarding(page);

    const composer = page.getByRole("combobox", { name: "Message Chief" });
    await composer.fill("Keep this draft");

    await page.route(new RegExp(`/pages/${failing}\\.tsx`), (route) =>
      route.fulfill({ status: 404 }),
    );
    await page
      .locator("main")
      .getByRole("button", { name: /^Chief/ })
      .click();

    const settings = page.getByTestId("bot-settings");
    await settings.getByText("Advanced", { exact: true }).click();
    await expect(settings.getByText("Could not load", { exact: true })).toBeVisible();
    await expect(settings.getByTestId(intact)).toBeVisible();
    await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await expect(composer).toHaveValue("Keep this draft");
  });
}
