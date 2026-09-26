import { expect, type Locator, type Page, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

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
      // The quote pill positions itself off the selection rect — keep the scope
      // inside the viewport or a fixed-position pill renders offscreen.
      el.scrollIntoView({ block: "center" });
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

  const sourceText = `quote-source-${stamp} shows **forty two percent** growth`;
  await composer.fill(sourceText);
  await composer.press("Enter");
  const sourceRow = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: `quote-source-${stamp}` })
    .first();
  await expect(sourceRow).toBeVisible({ timeout: 20_000 });

  // Selection inside one message offers the Quote action; Escape dismisses it.
  await selectAndRelease(page, sourceRow, "**forty two percent**");
  await expect(quoteButton).toBeVisible();
  await captureScreenshot(page, testInfo, "message-quote-selection");
  await page.keyboard.press("Escape");
  await expect(quoteButton).toHaveCount(0);

  // A selection with no mouse release (keyboard, assistive tech) still offers
  // Quote — the affordance hangs off selectionchange, not mouseup.
  await selectAndRelease(page, sourceRow, "**forty two percent**", "**forty two percent**", {
    release: false,
  });
  await expect(quoteButton).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(quoteButton).toHaveCount(0);

  // Quoting arms the existing reply flow with the excerpt in the chip. The
  // pill unmounts on click, so focus must land in the composer — and the
  // chip's arrival is announced through the composer live region.
  await selectAndRelease(page, sourceRow, "**forty two percent**");
  await expect(quoteButton).toBeVisible();
  await quoteButton.click();
  const replyChip = page.getByTestId("reply-chip");
  await expect(replyChip).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(page.getByTestId("composer-announcement")).toHaveText(/Replying to/);
  await expect(replyChip).toContainText(/Replying to/);
  await expect(replyChip).toContainText("**forty two percent**");

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
  // The accessible name names the action AND the excerpt — the quote must not
  // be masked by a bare "Jump to replied message" label.
  await expect(parentPreview).toHaveAccessibleName(/Jump to replied message:.*forty two percent/);
  await expect(parentPreview).toContainText("**forty two percent**");
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
  await expect(reloadedRow.getByTestId("reply-parent-preview")).toContainText(
    "**forty two percent**",
  );
});

test("rendered markdown selections survive server quote derivation", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `quote-markdown-${stamp}@rakazo.test`, "password12", "Quote Tester");
  await completeOnboarding(page);

  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });
  const sourceMarker = `md-${stamp}`;
  await composer.fill(`quote markdown fixture ${sourceMarker}`);
  await composer.press("Enter");

  // Bot bubble: scripted fixture → ChatMarkdown + server markdown derivation.
  const sourceRow = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-bot-bubble") })
    .filter({ hasText: sourceMarker })
    .first();
  await expect(sourceRow).toBeVisible({ timeout: 20_000 });

  const quoteAndSend = async (start: string, end: string, replyMarker: string) => {
    await selectAndRelease(page, sourceRow, start, end);
    await page.getByTestId("quote-selection").click();
    await composer.fill(replyMarker);
    await composer.press("Enter");
    const replyRow = transcript
      .locator("[data-message-id]")
      .filter({ has: page.getByTestId("message-user-bubble") })
      .filter({ hasText: replyMarker })
      .first();
    await expect(replyRow).toBeVisible({ timeout: 20_000 });
    return replyRow.getByTestId("reply-parent-preview");
  };

  await expect(await quoteAndSend("list-a", "list-b", `reply-list-${stamp}`)).toContainText(
    "list-a list-b",
  );
  await expect(await quoteAndSend("cell-a", "cell-b", `reply-table-${stamp}`)).toContainText(
    "cell-a cell-b",
  );
  // Row drags cross the card's row-number gutter and pager footer — chrome
  // text is unselectable so the excerpt still matches the rendered table.
  await expect(await quoteAndSend("cell-a", "cell-d", `reply-table-rows-${stamp}`)).toContainText(
    "cell-a cell-b cell-c cell-d",
  );
  await captureScreenshot(page, testInfo, "quote-table-row-selection");
  await expect(await quoteAndSend("cell-c", "rows", `reply-table-footer-${stamp}`)).toContainText(
    "cell-c cell-d",
  );
  await expect(await quoteAndSend("code-a", "code-b", `reply-code-${stamp}`)).toContainText(
    "code-a --- code-b",
  );

  // A quote-free reply falls back to the parent's preview — flattened, not raw Markdown.
  const rail = sourceRow.getByTestId("message-hover-rail");
  await expect
    .poll(async () => {
      await sourceRow.hover();
      return rail.evaluate((element) => getComputedStyle(element).opacity);
    })
    .toBe("1");
  await rail.getByRole("button", { name: "Reply" }).click();
  await composer.fill(`reply-plain-${stamp}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const plainReply = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: `reply-plain-${stamp}` })
    .first();
  const plainPreview = plainReply.getByTestId("reply-parent-preview");
  await expect(plainPreview).toContainText("cell-a, cell-b");
  await expect(plainPreview).not.toContainText("|");
  await captureScreenshot(page, testInfo, "reply-preview-plain-text");
});

test("an armed reply survives the parent paging out of the transcript", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `quote-evict-${stamp}@rakazo.test`, "password12", "Quote Tester");
  await completeOnboarding(page);

  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });
  const botId = activeBotId(page);
  const userRow = (text: string) =>
    transcript
      .locator("[data-message-id]")
      .filter({ has: page.getByTestId("message-user-bubble") })
      .filter({ hasText: text })
      .first();

  const parentText = `quote-evict-parent-${stamp}`;
  await composer.fill(parentText);
  await composer.press("Enter");
  const parentRow = userRow(parentText);
  await expect(parentRow).toBeVisible({ timeout: 20_000 });

  await selectAndRelease(page, parentRow, `evict-parent-${stamp}`);
  await page.getByTestId("quote-selection").click();
  const replyChip = page.getByTestId("reply-chip");
  await expect(replyChip).toBeVisible();
  await expect(replyChip).toContainText(`evict-parent-${stamp}`);

  // Newer durable messages push the parent out of the latest page (window is
  // 100). While the flood's runs are alive, every refresh races the event
  // stream and gets discarded as stale — so stop the thread first: the
  // cancel/terminal event then triggers a refresh whose snapshot cannot be
  // stale, committing the post-flood window without the parent.
  for (let i = 0; i < 105; i++) {
    await rpc(page, "threads/send", {
      botId,
      text: `quote-filler-${stamp}-${i}`,
      clientNonce: `qf-${stamp}-${i}`,
    });
  }
  const lastFiller = userRow(`quote-filler-${stamp}-104`);
  await expect(lastFiller).toBeVisible({ timeout: 30_000 });
  await rpc(page, "threads/stop", { botId });
  // If every run already finished before the stop, no terminal event fires —
  // nudge a refresh by reopening the computer panel until one lands quiet.
  const computerButton = page.getByTitle("Agent computer");
  await expect(async () => {
    if ((await computerButton.getAttribute("data-active")) !== null) {
      await computerButton.click();
    }
    await computerButton.click();
    expect(await parentRow.count()).toBe(0);
  }).toPass({ timeout: 30_000 });
  await expect(replyChip).toBeVisible();

  const replyText = `quote-evict-reply-${stamp}`;
  await composer.fill(replyText);
  await composer.press("Enter");
  const replyRow = userRow(replyText);
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  const parentPreview = replyRow.getByTestId("reply-parent-preview");
  await expect(parentPreview).toBeVisible();
  await expect(parentPreview).toContainText(`evict-parent-${stamp}`);

  // The link still reaches the evicted parent via the around-page jump.
  await parentPreview.click();
  await expect(userRow(parentText)).toBeVisible({ timeout: 20_000 });
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

test("quoting a second message retargets the armed reply", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `quote-switch-${stamp}@rakazo.test`, "password12", "Quote Tester");
  await completeOnboarding(page);

  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });
  const quoteButton = page.getByTestId("quote-selection");
  const replyChip = page.getByTestId("reply-chip");
  const userRow = (text: string) =>
    transcript
      .locator("[data-message-id]")
      .filter({ has: page.getByTestId("message-user-bubble") })
      .filter({ hasText: text })
      .first();

  const firstText = `quote-switch-a-${stamp}`;
  const secondText = `quote-switch-b-${stamp}`;
  // Each send must resolve before the next Enter — the composer swallows
  // input while a send is in flight.
  const sentFirst = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.ok(),
  );
  await composer.fill(firstText);
  await composer.press("Enter");
  await sentFirst;
  const firstRow = userRow(firstText);
  await expect(firstRow).toBeVisible({ timeout: 20_000 });
  const sentSecond = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.ok(),
  );
  await composer.fill(secondText);
  await composer.press("Enter");
  await sentSecond;
  const secondRow = userRow(secondText);
  await expect(secondRow).toBeVisible({ timeout: 20_000 });

  // Arm a quote on the first message…
  await selectAndRelease(page, firstRow, firstText);
  await quoteButton.click();
  await expect(replyChip).toContainText("switch-a");
  await expect(composer).toBeFocused();

  // …then quote the second: the chip retargets, the announcement re-fires,
  // and focus returns to the composer instead of dropping to <body>.
  await secondRow.scrollIntoViewIfNeeded();
  await selectAndRelease(page, secondRow, secondText);
  await quoteButton.click();
  await expect(replyChip).toContainText("switch-b");
  await expect(replyChip).not.toContainText("switch-a");
  await expect(composer).toBeFocused();
  await expect(page.getByTestId("composer-announcement")).toHaveText(/Replying to/);
});
