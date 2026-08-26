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

  // Keep the pill visible for the artifact (full-page shots can drop :hover).
  await toolbar.evaluate((el) => {
    const node = el as HTMLElement;
    node.style.opacity = "1";
    node.style.pointerEvents = "auto";
  });
  const toolbarBox = await toolbar.boundingBox();
  const bubbleBox = await bubble.boundingBox();
  if (!toolbarBox || !bubbleBox) throw new Error("missing hover toolbar geometry");
  const pad = 16;
  const clip = {
    x: Math.max(0, Math.min(toolbarBox.x, bubbleBox.x) - pad),
    y: Math.max(0, toolbarBox.y - pad),
    width:
      Math.max(toolbarBox.x + toolbarBox.width, bubbleBox.x + bubbleBox.width) -
      Math.min(toolbarBox.x, bubbleBox.x) +
      pad * 2,
    height: bubbleBox.y + bubbleBox.height - toolbarBox.y + pad * 2,
  };
  const hoverPath = testInfo.outputPath("message-hover-toolbar.png");
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    clip,
    path: hoverPath,
  });
  await testInfo.attach("message-hover-toolbar", { contentType: "image/png", path: hoverPath });

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
