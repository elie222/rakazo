import { expect, type Locator, type Page, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

/**
 * Build a real browser Selection over `startNeedle` … `endNeedle` inside `scope`
 * (a row for same-message picks, the transcript for cross-message picks), then
 * fire a trusted mouseup over the transcript so the app re-reads the selection.
 * A lone mouse.up keeps the selection alive — a mousedown would clear it first.
 * Pass `release: false` to exercise the selectionchange-only path instead.
 */
async function selectAndRelease(
  page: Page,
  scope: Locator,
  startNeedle: string,
  endNeedle = startNeedle,
  options: { release?: boolean } = {},
) {
  await scope.evaluate(
    (el, { startNeedle, endNeedle }) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let node = walker.nextNode();
      while (node) {
        nodes.push(node as Text);
        node = walker.nextNode();
      }
      const find = (needle: string, fromEnd: boolean) => {
        const list = fromEnd ? [...nodes].reverse() : nodes;
        for (const text of list) {
          const idx = text.textContent?.indexOf(needle) ?? -1;
          if (idx >= 0) return { node: text, idx };
        }
        return null;
      };
      const start = find(startNeedle, false);
      const end = find(endNeedle, true);
      if (!start || !end) throw new Error(`selection needles not found: ${startNeedle}`);
      const range = document.createRange();
      range.setStart(start.node, start.idx);
      range.setEnd(end.node, end.idx + endNeedle.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { startNeedle, endNeedle },
  );
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  if (!selected.includes(startNeedle)) {
    throw new Error(`selection did not stick (got: "${selected.slice(0, 80)}")`);
  }
  if (options.release === false) return;
  const transcript = page.getByTestId("transcript");
  const box = await transcript.boundingBox();
  if (!box) throw new Error("transcript not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.up();
}

test("selecting a text span quotes it into a reply", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `quote-${stamp}@rakazo.test`, "password12", "Quote Tester");
  await completeOnboarding(page);

  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });
  const quoteButton = page.getByTestId("quote-selection");

  const sourceText = `quote-source-${stamp} shows forty two percent growth`;
  await composer.fill(sourceText);
  await composer.press("Enter");
  const sourceRow = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: `quote-source-${stamp}` })
    .first();
  await expect(sourceRow).toBeVisible({ timeout: 20_000 });

  // Selection inside one message offers the Quote action; Escape dismisses it.
  await selectAndRelease(page, sourceRow, "forty two percent");
  await expect(quoteButton).toBeVisible();
  await captureScreenshot(page, testInfo, "message-quote-selection");
  await page.keyboard.press("Escape");
  await expect(quoteButton).toHaveCount(0);

  // A selection with no mouse release (keyboard, assistive tech) still offers
  // Quote — the affordance hangs off selectionchange, not mouseup.
  await selectAndRelease(page, sourceRow, "forty two percent", "forty two percent", {
    release: false,
  });
  await expect(quoteButton).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(quoteButton).toHaveCount(0);

  // Quoting arms the existing reply flow with the excerpt in the chip.
  await selectAndRelease(page, sourceRow, "forty two percent");
  await expect(quoteButton).toBeVisible();
  await quoteButton.click();
  const replyChip = page.getByTestId("reply-chip");
  await expect(replyChip).toBeVisible();
  await expect(replyChip).toContainText(/Replying to/);
  await expect(replyChip).toContainText("forty two percent");

  const replyText = `quote-reply-${stamp} why this number?`;
  await composer.fill(replyText);
  await composer.press("Enter");
  await expect(replyChip).toHaveCount(0);

  // The sent message shows the excerpt and keeps jump-to-source.
  const replyRow = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: replyText })
    .first();
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  const parentPreview = replyRow.getByTestId("reply-parent-preview");
  await expect(parentPreview).toBeVisible();
  await expect(parentPreview).toContainText("forty two percent");
  await expect(parentPreview).not.toContainText("quote-source");
  await captureScreenshot(page, testInfo, "message-quote-reply");

  await parentPreview.click();
  await expect(sourceRow).toBeInViewport();

  // The excerpt is persisted — it still renders after a full reload.
  await page.reload();
  const reloadedRow = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: replyText })
    .first();
  await expect(reloadedRow).toBeVisible({ timeout: 20_000 });
  await expect(reloadedRow.getByTestId("reply-parent-preview")).toContainText("forty two percent");
});

test("a selection spanning two messages offers no quote action", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `quote-span-${stamp}@rakazo.test`, "password12", "Quote Tester");
  await completeOnboarding(page);

  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });
  // The scripted bot echoes user text; scope to user bubbles for unique rows.
  const userRow = (text: string) =>
    transcript
      .locator("[data-message-id]")
      .filter({ has: page.getByTestId("message-user-bubble") })
      .filter({ hasText: text })
      .first();

  const firstText = `quote-first-${stamp}`;
  const secondText = `quote-second-${stamp}`;
  await composer.fill(firstText);
  await composer.press("Enter");
  await expect(userRow(firstText)).toBeVisible({ timeout: 20_000 });
  await composer.fill(secondText);
  await composer.press("Enter");
  await expect(userRow(secondText)).toBeVisible({ timeout: 20_000 });

  await selectAndRelease(page, transcript, firstText, secondText);
  await expect(page.getByTestId("quote-selection")).toHaveCount(0);
});
