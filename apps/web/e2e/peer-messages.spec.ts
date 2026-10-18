import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("shows peer chips in transcript and opens view-only peer chat", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `peer-msg-${stamp}@rakazo.test`, "password12", "Peer Msg");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  await rpc(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("message the bot named Researcher saying peer-exchange-alpha");
  await composer.press("Enter");

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
        }>(page, "threads/messages", { botId: chiefId, includePeerRuns: true });
        const peerTexts = history.messages.flatMap((message) =>
          message.blocks
            .filter(
              (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
            )
            .map((block) => block.text ?? ""),
        );
        return peerTexts.some((text) => text.includes("peer-exchange-alpha"));
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  const transcript = page.getByTestId("transcript");
  const chip = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "Researcher" })
    .first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip.getByText(/Messaged|Message from/)).toBeVisible();
  await expect(chip).toHaveAccessibleName(/Messaged Researcher|Message from Researcher/);
  await expect(chip.locator(".rakazo-organic-avatar")).toBeVisible();
  await expect(chip).not.toContainText("{peer}");
  // User bubble still contains the phrase; peer body must not appear outside the chip.
  await expect(chip).not.toContainText("peer-exchange-alpha");
  await expect(transcript.getByText("peer-exchange-alpha")).toHaveCount(1);
  const assertChipLeftAligned = async () => {
    const transcriptBox = await transcript.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(transcriptBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    // Transcript padding is 16px mobile / 28px desktop; centering must fail this assertion.
    expect(chipBox!.x - transcriptBox!.x).toBeLessThanOrEqual(32);
    // Stay under 75% of the transcript width so the chip cannot become a full-width bar.
    expect(chipBox!.width).toBeLessThan(transcriptBox!.width * 0.75);
  };

  await assertChipLeftAligned();
  await expect(composer).toBeVisible();
  await captureScreenshot(page, testInfo, "peer-chip-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await chip.scrollIntoViewIfNeeded();
  await expect(chip).toBeVisible();
  await expect(composer).toBeVisible();
  await assertChipLeftAligned();
  await captureScreenshot(page, testInfo, "peer-chip-mobile");

  await chip.focus();
  await expect(chip).toBeFocused();
  await chip.press("Enter");
  const view = page.getByTestId("peer-conversation-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("heading", { name: /Chief · Researcher/ })).toBeVisible();
  await expect(view.getByText("This chat is view-only")).toBeVisible();
  await expect(view.getByRole("button", { name: "Close" })).toHaveCount(1);
  await expect(view.getByText("peer-exchange-alpha").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await expect(view.getByText("Loading")).toHaveCount(0);
  const peerTranscript = view.getByTestId("peer-conversation-transcript");
  await peerTranscript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      peerTranscript.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
  await captureScreenshot(page, testInfo, "peer-view-only");
});

const foldedReplyText = "on it. i will work this in the background";

/** Chief messages Researcher; Researcher's reply comes back to Chief folded under its marker. */
async function openFoldedPeerReply(page: Page, name: string) {
  await signup(page, `${name}-${Date.now()}@rakazo.test`, "password12", "Peer Fold");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const researcher = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("message the bot named Researcher saying peer-fold-alpha");
  await composer.press("Enter");

  // Researcher's reply comes back to Chief as a peer run: marker plus the woken run's text.
  const transcript = page.getByTestId("transcript");
  const marker = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "Message from Researcher" });
  await expect(marker).toBeVisible({ timeout: 60_000 });
  await expect(transcript.getByText("messaging that bot now.")).toBeVisible();
  const reply = transcript.getByText(foldedReplyText);
  await expect(reply).toHaveCount(0);
  return { researcher, composer, transcript, reply };
}

test("folds a peer run's reply under its marker and keeps its ask inline", async ({
  page,
}, testInfo) => {
  const { researcher, composer, transcript, reply } = await openFoldedPeerReply(page, "peer-fold");

  const toggle = transcript.getByRole("button", { name: "Expand Message from Researcher" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await captureScreenshot(page, testInfo, "peer-replies-folded");
  await toggle.click();
  await expect(reply).toBeVisible();
  // The toggle only folds; the label alone opens the peer chat.
  await expect(page.getByTestId("peer-conversation-view")).toHaveCount(0);
  const collapse = transcript.getByRole("button", { name: "Collapse Message from Researcher" });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await captureScreenshot(page, testInfo, "peer-replies-expanded");
  await collapse.focus();
  await collapse.press("Enter");
  await expect(reply).toHaveCount(0);
  await toggle.press(" ");
  await expect(reply).toBeVisible();

  // An ask from the woken run stays inline in the recipient's thread; its text folds.
  await composer.fill("message the bot named Researcher saying which city peer-fold-beta");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
  await page.goto(`/app/${researcher.id}`);
  const researcherTranscript = page.getByTestId("transcript");
  await expect(
    researcherTranscript.locator("p").filter({ hasText: /^Which city should I use\?$/ }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    researcherTranscript.getByTestId("peer-receipt-chip").filter({ hasText: "Message from Chief" }),
  ).toHaveCount(2);
  await expect(researcherTranscript.getByText("i need a decision before i continue.")).toHaveCount(
    0,
  );

  // The user's answer joins the peer run but is not a bot reply, so it stays out of the fold.
  await page.getByRole("combobox", { name: "Message Researcher" }).fill("Paris");
  await page.getByRole("combobox", { name: "Message Researcher" }).press("Enter");
  await expect(
    researcherTranscript.getByTestId("message-user-bubble").filter({ hasText: /^Paris$/ }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    researcherTranscript.getByRole("button", { name: "Expand Message from Chief" }),
  ).toHaveCount(2);
  await captureScreenshot(page, testInfo, "peer-run-answer-inline");
});

/** The folded reply, expanded by hand; later scripted replies repeat its text, so it goes by id. */
async function expandFoldedPeerReply(page: Page, name: string) {
  const opened = await openFoldedPeerReply(page, name);
  const { transcript } = opened;
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
  const expand = transcript.getByRole("button", { name: "Expand Message from Researcher" });
  const collapse = transcript.getByRole("button", { name: "Collapse Message from Researcher" });
  await expand.click();
  const replyId = await transcript
    .locator("[data-message-id]")
    .filter({ hasText: foldedReplyText })
    .getAttribute("data-message-id");
  const replyRow = transcript.locator(`[data-message-id="${replyId}"]`);
  return { ...opened, expand, collapse, replyRow };
}

test("opens a folded peer reply from a search hit", async ({ page }, testInfo) => {
  const { transcript, reply } = await openFoldedPeerReply(page, "peer-search");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  await page.getByTestId("sidebar-search").getByRole("textbox").fill(foldedReplyText);
  await page
    .getByRole("button")
    .filter({ hasText: `Chief · ${foldedReplyText}` })
    .first()
    .click();
  const collapse = transcript.getByRole("button", { name: "Collapse Message from Researcher" });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(reply).toBeInViewport();
  await captureScreenshot(page, testInfo, "peer-reply-search-jump");
});

test("opens a folded peer reply from a reply quote", async ({ page }, testInfo) => {
  const { composer, transcript, collapse, replyRow } = await expandFoldedPeerReply(
    page,
    "peer-quote",
  );
  await replyRow.hover();
  await replyRow.getByRole("button", { name: "Reply", exact: true }).click();
  await composer.fill("peer-fold-quote");
  await composer.press("Enter");
  const quote = transcript
    .locator("[data-message-id]")
    .filter({ hasText: "peer-fold-quote" })
    .getByTestId("reply-parent-preview");
  await expect(quote).toBeVisible({ timeout: 20_000 });
  await collapse.click();
  await expect(replyRow).toHaveCount(0);

  await quote.click();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(replyRow).toBeInViewport();
  await captureScreenshot(page, testInfo, "peer-reply-quote-jump");
});

test("keeps a reaction with its folded peer reply", async ({ page }, testInfo) => {
  const { transcript, expand, collapse, replyRow } = await expandFoldedPeerReply(
    page,
    "peer-react",
  );
  await replyRow.hover();
  await replyRow.getByRole("button", { name: "React" }).click();
  await page.getByRole("button", { name: "👍", exact: true }).click();
  await expect(replyRow.getByTestId("message-reactions")).toHaveText("👍");

  // Folded: no stray reaction bubble. Expanded again: the count is back on the reply.
  await collapse.click();
  await expect(replyRow).toHaveCount(0);
  await expect(transcript.getByText("👍", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "peer-reply-reaction-folded");
  await expand.click();
  const reactions = replyRow.getByTestId("message-reactions");
  await expect(reactions).toHaveText("👍");
  await reactions.scrollIntoViewIfNeeded();
  await expect(reactions).toBeInViewport();
  await captureScreenshot(page, testInfo, "peer-reply-reaction-expanded");
});

test("keeps a keyboard-expanded peer marker in view", async ({ page }, testInfo) => {
  const { transcript, reply } = await openFoldedPeerReply(page, "peer-keys");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
  // Short enough that the expanded reply is taller than the space below the marker.
  await page.setViewportSize({ width: 390, height: 360 });
  await transcript.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));

  const toggle = transcript.getByRole("button", { name: "Expand Message from Researcher" });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(reply).toBeAttached();
  const collapse = transcript.getByRole("button", { name: "Collapse Message from Researcher" });
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await expect(collapse).toBeFocused();
  await expect(collapse).toBeInViewport();
  await captureScreenshot(page, testInfo, "peer-replies-keyboard-expanded");
});
