import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("message hover shows Reply and Copy; reply links to parent", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `hover-actions-${stamp}@rakazo.test`, "password12", "Hover Actions");
  await completeOnboarding(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const parentText = `hover-parent-${stamp}`;
  const replyText = `hover-reply-${stamp}`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
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
  const thumbsUp = toolbar.getByRole("button", { name: "Add thumbs-up" });
  await expect(thumbsUp).toBeVisible();

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

  await thumbsUp.click();
  const reactionChip = parentRow
    .getByRole("button", { name: "Remove thumbs-up" })
    .filter({ hasText: "👍" });
  await expect(reactionChip).toBeVisible();
  await captureScreenshot(page, testInfo, "message-thumbs-up");

  await parentRow.hover();
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

test("reply preview jumps to parent outside the loaded page", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `hover-page-${stamp}@rakazo.test`, "password12", "Hover Page");
  await completeOnboarding(page);

  const parentText = `page-parent-${stamp}`;
  const replyText = `page-reply-${stamp}`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(parentText);
  await composer.press("Enter");

  const transcript = page.getByTestId("transcript");
  const parentRow = transcript.locator(`[data-message-id]`).filter({ hasText: parentText }).first();
  await expect(parentRow).toBeVisible({ timeout: 20_000 });
  const parentId = await parentRow.getAttribute("data-message-id");
  expect(parentId).toBeTruthy();

  await parentRow.hover();
  await parentRow.getByRole("button", { name: "Reply" }).click();
  await composer.fill(replyText);
  await composer.press("Enter");

  const replyRow = transcript.locator(`[data-message-id]`).filter({ hasText: replyText }).first();
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  await expect(replyRow.getByTestId("reply-parent-preview")).toContainText(parentText);

  // Simulate a paginated snapshot where the parent is older than the loaded page.
  // Bootstrap and threads/get both hydrate the transcript on reload.
  const stripParent = (body: {
    json?: {
      messages?: Array<{ id: string }>;
      olderCursor?: number | null;
      thread?: { messages?: Array<{ id: string }>; olderCursor?: number | null };
    };
  }) => {
    if (body.json?.messages) {
      body.json.messages = body.json.messages.filter((message) => message.id !== parentId);
      body.json.olderCursor = body.json.olderCursor ?? 1;
    }
    if (body.json?.thread?.messages) {
      body.json.thread.messages = body.json.thread.messages.filter(
        (message) => message.id !== parentId,
      );
      body.json.thread.olderCursor = body.json.thread.olderCursor ?? 1;
    }
  };

  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Parameters<typeof stripParent>[0];
    stripParent(body);
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  });
  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Parameters<typeof stripParent>[0];
    stripParent(body);
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toHaveCount(0);
  const offlinePreview = page
    .locator(`[data-message-id]`)
    .filter({ hasText: replyText })
    .getByTestId("reply-parent-preview");
  await expect(offlinePreview).toBeVisible();
  await expect(offlinePreview).toHaveText("Earlier message");

  await page.unroute("**/rpc/bootstrap");
  await page.unroute("**/rpc/threads/get");
  await offlinePreview.click();
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toContainText(parentText);
});
