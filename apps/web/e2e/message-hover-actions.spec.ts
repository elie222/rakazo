import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("message hover shows Reply and Copy; reply links to parent", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `hover-actions-${stamp}@rakazo.test`, "password12", "Hover Actions");
  await completeOnboarding(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const parentText = `hover-parent-${stamp}`;
  const replyText = `hover-reply-${stamp}`;
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(parentText);
  await composer.press("Enter");

  const transcript = page.getByTestId("transcript");
  const parentRow = transcript.locator(`[data-message-id]`).filter({ hasText: parentText }).first();
  await expect(parentRow).toBeVisible({ timeout: 20_000 });

  await parentRow.hover();
  const toolbar = parentRow.getByTestId("message-hover-actions");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Copy" })).toBeVisible();

  // Pill must float above the bubble text, not cover the first line.
  const bubble = parentRow.locator("div").filter({ hasText: parentText }).last();
  await expect
    .poll(async () => {
      const toolbarBox = await toolbar.boundingBox();
      const bubbleBox = await bubble.boundingBox();
      if (!toolbarBox || !bubbleBox) return null;
      return toolbarBox.y + toolbarBox.height <= bubbleBox.y + 1;
    })
    .toBe(true);
  await captureScreenshot(page, testInfo, "message-hover-toolbar");

  await toolbar.getByRole("button", { name: "Copy" }).click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(parentText);

  await parentRow.hover();
  await toolbar.getByRole("button", { name: "Reply" }).click();
  const replyChip = page.getByTestId("reply-chip");
  await expect(replyChip).toBeVisible();
  await expect(replyChip).toContainText(/Replying to/);

  await composer.fill(replyText);
  await composer.press("Enter");
  await expect(replyChip).toHaveCount(0);

  const replyRow = transcript.locator(`[data-message-id]`).filter({ hasText: replyText }).first();
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  const parentPreview = replyRow.getByTestId("reply-parent-preview");
  await expect(parentPreview).toBeVisible();
  await expect(parentPreview).toContainText(parentText);
  await captureScreenshot(page, testInfo, "message-reply-thread");

  await parentPreview.click();
  await expect(parentRow).toBeInViewport();
});
