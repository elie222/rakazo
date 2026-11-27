import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

test("the chat never scrolls sideways, even with card actions showing in a narrow window", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto("/e2e/fixtures/gallery.html?embed&scenario=secrets");
  const transcript = page.getByTestId("transcript");
  const row = page
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("secret-ask-card") });
  await row.first().hover();
  await expect(row.first().getByTestId("message-hover-rail")).toHaveCSS("opacity", "1");
  await page.mouse.wheel(400, 0);
  await expect.poll(() => transcript.evaluate((node) => node.scrollLeft)).toBe(0);
  await captureScreenshot(page, testInfo, "transcript-no-sideways-scroll");
});

test("the login action sits below the site in a narrow chat", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e/fixtures/gallery.html?embed&scenario=secrets");
  const card = page
    .getByTestId("secret-ask-card")
    .filter({ hasText: "Sign in to the vendor portal." });
  const site = card.getByText("portal.example.test");
  const action = card.getByRole("button", { name: "Continue" });
  await expect(site).toBeVisible();
  await expect(action).toBeVisible();
  const siteBox = await site.boundingBox();
  const actionBox = await action.boundingBox();
  expect(actionBox!.y).toBeGreaterThanOrEqual(siteBox!.y + siteBox!.height);
  await captureScreenshot(page, testInfo, "secret-login-card-narrow");
});
