import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  signup,
} from "../helpers/helpers";

/** The More menu sits on the hover rail, which shows once the pointer is over the row. */
async function openMore(row: Locator) {
  const more = row.getByTestId("message-hover-rail").getByRole("button", { name: "More" });
  await expect
    .poll(async () => {
      await row.hover();
      return more.isVisible();
    })
    .toBe(true);
  await more.click();
}

test("shares one bot reply by link, opens it signed out, and removes it", async ({
  page,
  browser,
}, testInfo) => {
  await signup(page, `reply-share-${Date.now()}@rakazo.test`, "password12", "Reply Sharer");
  await completeOnboarding(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /Day-to-day work/ }).click();
  const botText = page.getByText(/Got it\./);
  await expect(botText).toBeVisible({ timeout: 20_000 });
  const row = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ has: botText })
    .first();

  await openMore(row);
  await page.getByRole("menuitem", { name: "Share" }).click();
  const dialog = page.getByTestId("reply-share");
  await expect(dialog.getByText("Anyone with the link can read this reply")).toBeVisible();
  const shown = await dialog.getByTestId("reply-share-text").textContent();
  expect(shown).toMatch(/^Got it\./);
  await captureScreenshot(page, testInfo, "reply-share-dialog");

  await dialog.getByRole("button", { name: "Copy link" }).click();
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
  const shareUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(shareUrl).pathname).toMatch(/^\/c\/[A-Za-z0-9_-]{43}$/);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Signed out, the link shows the reply's text, its bot and the date, and nothing else.
  const visitor = await browser.newContext();
  const outside = await visitor.newPage();
  const served = await outside.goto(shareUrl);
  expect(served?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(served?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(outside.getByTestId("shared-reply-text")).toHaveText(shown ?? "");
  await expect(outside.locator("time")).toBeVisible();
  await captureScreenshot(outside, testInfo, "reply-share-public");

  const settings = await openUserSettings(page);
  const shared = settings.getByTestId("shared-replies");
  await expect(shared.getByText("Shared links")).toBeVisible();
  const remove = shared.getByRole("button", { name: /^Remove link to .+'s reply$/ });
  await expect(remove).toHaveCount(1);
  await shared.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "reply-share-settings");
  await remove.click();
  await expect(shared).toBeHidden();

  await outside.reload();
  await expect(outside.getByRole("heading", { name: "This reply isn't available" })).toBeVisible();
  await captureScreenshot(outside, testInfo, "reply-share-unavailable");
  await visitor.close();
});
