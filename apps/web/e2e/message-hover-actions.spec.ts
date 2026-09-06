import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

async function revealHoverRail(
  row: import("@playwright/test").Locator,
): Promise<import("@playwright/test").Locator> {
  const rail = row.getByTestId("message-hover-rail");
  await expect
    .poll(async () => {
      await row.hover();
      return rail.evaluate((element) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, pointerEvents: style.pointerEvents };
      });
    })
    .toEqual({ opacity: "1", pointerEvents: "auto" });
  // Incoming replies can move the row away from the pointer; keep real focus for screenshots.
  await rail.getByRole("button", { name: "More" }).focus();
  return rail;
}

/** Park the pointer outside the message and blur focus so the rail returns to opacity-0. */
async function expectRailAtRest(
  page: import("@playwright/test").Page,
  row: import("@playwright/test").Locator,
) {
  const rail = row.getByTestId("message-hover-rail");
  const box = await row.boundingBox();
  if (box) {
    // (0,0) can still sit on the first transcript row; leave below the row instead.
    await page.mouse.move(Math.max(0, box.x) + 8, box.y + box.height + 32);
  }
  // More keeps focus after Escape; blur so focus-within does not leave the rail visible.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await expect(rail).toHaveCSS("opacity", "0");
}

test("message hover shows beside-bubble actions; reply links to parent", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `hover-actions-${stamp}@rakazo.test`, "password12", "Hover Actions");
  await completeOnboarding(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const transcript = page.getByTestId("transcript");

  // Bot welcome (left bubble): rail hidden at rest, then beside on hover.
  const botRow = transcript.locator(`[data-message-id]`).first();
  await expect(botRow).toBeVisible();
  await expectRailAtRest(page, botRow);
  await captureScreenshot(page, testInfo, "message-actions-rest-desktop");

  const botRail = await revealHoverRail(botRow);
  const botToolbar = botRow.getByTestId("message-hover-actions");
  await expect(botToolbar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(botToolbar.getByRole("button", { name: "More" })).toBeVisible();
  // Measure the visible bubble, so an oversized wrapper cannot hide a gap.
  const botFrame = botRow.getByTestId("message-bot-bubble");
  await expect
    .poll(async () => {
      const railBox = await botRail.boundingBox();
      const frameBox = await botFrame.boundingBox();
      if (!railBox || !frameBox) return null;
      const railMid = railBox.y + railBox.height / 2;
      const frameMid = frameBox.y + frameBox.height / 2;
      return {
        beside: railBox.x >= frameBox.x + frameBox.width - 2,
        flush: railBox.x - (frameBox.x + frameBox.width) < 8,
        centered: Math.abs(railMid - frameMid) <= 12,
        notBelow: railBox.y + railBox.height <= frameBox.y + frameBox.height + 12,
      };
    })
    .toEqual({ beside: true, flush: true, centered: true, notBelow: true });
  await captureScreenshot(page, testInfo, "message-bot-actions-desktop");
  await expectRailAtRest(page, botRow);

  const parentText = `hover-parent-${stamp}`;
  const replyText = `hover-reply-${stamp}`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(parentText);
  await composer.press("Enter");

  const parentRow = transcript.locator(`[data-message-id]`).filter({ hasText: parentText }).first();
  await expect(parentRow).toBeVisible({ timeout: 20_000 });

  const rail = await revealHoverRail(parentRow);
  const toolbar = parentRow.getByTestId("message-hover-actions");
  await expect(toolbar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "More" })).toBeVisible();
  const thumbsUp = toolbar.getByRole("button", { name: "Add thumbs-up" });
  await expect(thumbsUp).toBeVisible();
  // Default reaction matches Reply/More: muted control color, not yellow.
  await expect
    .poll(async () => {
      const mutedColor = await toolbar
        .getByRole("button", { name: "More" })
        .evaluate((el) => getComputedStyle(el).color);
      const reactionColor = await thumbsUp.evaluate((el) => getComputedStyle(el).color);
      return reactionColor === mutedColor;
    })
    .toBe(true);

  // User bubble (right): icons sit to the left, vertically centered — not under the bubble.
  const frame = parentRow.getByTestId("message-bubble-frame");
  await expect
    .poll(async () => {
      const railBox = await rail.boundingBox();
      const frameBox = await frame.boundingBox();
      if (!railBox || !frameBox) return null;
      const railMid = railBox.y + railBox.height / 2;
      const frameMid = frameBox.y + frameBox.height / 2;
      return {
        beside: railBox.x + railBox.width <= frameBox.x + 2,
        flush: frameBox.x - (railBox.x + railBox.width) < 8,
        centered: Math.abs(railMid - frameMid) <= 12,
        notBelow: railBox.y >= frameBox.y - 12,
      };
    })
    .toEqual({ beside: true, flush: true, centered: true, notBelow: true });

  // User bubble is a muted elevated surface (not cream invert / bright pill).
  const userSurface = parentRow.getByTestId("message-user-bubble");
  await expect(userSurface).toBeVisible();
  await expect
    .poll(async () => userSurface.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toMatch(/^rgb\(241,\s*241,\s*239\)$/); // not cream primary foreground

  // Long user bubble: rail stays ~6px beside the bubble edge, not the full row width.
  const longText = `hover-long-${stamp}-${"x".repeat(220)}`;
  await composer.fill(longText);
  await composer.press("Enter");
  const longRow = transcript
    .locator(`[data-message-id]`)
    .filter({ hasText: longText.slice(0, 40) })
    .first();
  await expect(longRow).toBeVisible({ timeout: 20_000 });
  const longRail = await revealHoverRail(longRow);
  const longFrame = longRow.getByTestId("message-bubble-frame");
  await expect
    .poll(async () => {
      const railBox = await longRail.boundingBox();
      const frameBox = await longFrame.boundingBox();
      if (!railBox || !frameBox) return null;
      return Math.abs(frameBox.x - (railBox.x + railBox.width));
    })
    .toBeLessThan(8);

  // Time is only visible after opening More.
  await expect(page.getByTestId("message-hover-time")).toHaveCount(0);
  await revealHoverRail(parentRow);
  await toolbar.getByRole("button", { name: "More" }).click();
  const moreTime = page.getByTestId("message-hover-time");
  await expect(moreTime).toBeVisible();
  await expect(moreTime).toHaveText(/\d/);
  // Escape closes More and restores focus to the trigger so the rail stays up.
  await page.keyboard.press("Escape");
  await expect(toolbar.getByRole("button", { name: "More" })).toBeFocused();
  await captureScreenshot(page, testInfo, "message-user-actions-hover-desktop");
  // Default transcript shot: rail at rest (no hover pin, mouse clear).
  await expectRailAtRest(page, parentRow);
  await captureScreenshot(page, testInfo, "message-user-bubble-desktop");

  // Clip shot of bubble + rail for gallery geometry.
  await revealHoverRail(parentRow);
  const railBox = await rail.boundingBox();
  const frameBox = await frame.boundingBox();
  if (!railBox || !frameBox) throw new Error("missing hover toolbar geometry");
  const pad = 16;
  const top = Math.min(railBox.y, frameBox.y);
  const clip = {
    x: Math.max(0, Math.min(railBox.x, frameBox.x) - pad),
    y: Math.max(0, top - pad),
    width:
      Math.max(railBox.x + railBox.width, frameBox.x + frameBox.width) -
      Math.min(railBox.x, frameBox.x) +
      pad * 2,
    height: Math.max(railBox.y + railBox.height, frameBox.y + frameBox.height) - top + pad * 2,
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
  await toolbar.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Copy" }).click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(parentText);
  await expect(toolbar.getByRole("button", { name: "More" })).toBeFocused();

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

  await page.setViewportSize({ width: 390, height: 844 });
  await botRow.scrollIntoViewIfNeeded();
  await revealHoverRail(botRow);
  await captureScreenshot(page, testInfo, "message-bot-actions-mobile");
  await parentRow.scrollIntoViewIfNeeded();
  await revealHoverRail(parentRow);
  await captureScreenshot(page, testInfo, "message-user-actions-mobile");
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

test.describe("touch message actions", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("More exposes actions without simulated hover", async ({ page }, testInfo) => {
    await signup(page, `touch-actions-${Date.now()}@rakazo.test`, "password12", "Touch Actions");
    await completeOnboarding(page);
    expect(
      await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches),
    ).toBe(false);
    const row = page.getByTestId("transcript").locator("[data-message-id]").first();
    const rail = row.getByTestId("message-hover-rail");
    await expect(rail).toHaveCSS("opacity", "1");
    await expect(rail.getByRole("button", { name: "Reply", exact: true })).toBeHidden();
    await rail.getByRole("button", { name: "More" }).tap();
    await expect(page.getByRole("menuitem", { name: "Copy" })).toBeVisible();
    await expect(page.getByTestId("message-hover-time")).toBeVisible();
    await captureScreenshot(page, testInfo, "message-actions-touch-menu");
    await page.getByRole("menuitem", { name: "Reply", exact: true }).tap();
    await expect(page.getByRole("button", { name: "Cancel reply" })).toBeVisible();
  });
});
