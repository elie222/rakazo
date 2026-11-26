import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers/helpers";

// Tall enough that each scenario's transcript fits without scrolling inside the chat pane.
test.use({ viewport: { width: 1280, height: 2200 } });

test("gallery keeps a paginated call closed and its follow-up visible", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?scenario=calls&theme=light");
  const call = page.getByTestId("voice-chat-card").first();
  await expect(call.getByText("Deploy check", { exact: true })).toBeVisible();
  await expect(call.getByText("2:05", { exact: true })).toBeVisible();
  await expect(page.getByText("Here is the deployment checklist.", { exact: true })).toBeVisible();
  await expect(call.getByText("Here is the deployment checklist.")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "paginated-call-marker");
});

test("a draft opens to mark the passages to change", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?scenario=drafts&theme=light");
  const card = page.getByTestId("draft-card").first();
  await card.getByRole("button", { name: "Open" }).click();
  // The note panel is a popover of its own, so the draft is found by its name.
  const dialog = page.getByRole("dialog", { name: /LinkedIn message/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Revise" })).toBeDisabled();
  for (const [passage, note] of [
    ["I hope this message finds you well.", "Warmer"],
    ["quick 15-minute call next week", "Suggest Tuesday"],
  ] as const) {
    await dialog.getByTestId("draft-body").evaluate((body, passage) => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(passage) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + passage.length);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        return;
      }
    }, passage);
    const panel = page.getByTestId("draft-note-panel");
    await panel.getByRole("textbox", { name: "What should change?" }).fill(note);
    await panel.getByRole("button", { name: "Add" }).click();
    await expect(panel).toBeHidden();
  }
  await expect(dialog.getByText("2 notes")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Revise" })).toBeEnabled();
  await captureScreenshot(page, testInfo, "draft-marked-up");
});

test("gallery shows a tool's question as plain text with its form", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?scenario=approvals&theme=light");
  const [open, declined] = await page.getByTestId("tool-question-card").all();
  await expect(open!.getByText("Run **send_email** to sam@example.test?")).toBeVisible();
  await expect(open!.getByRole("checkbox", { name: "Approve this call" })).toBeVisible();
  await expect(open!.getByRole("textbox", { name: "Reason" })).toBeVisible();
  await expect(open!.getByText("This call", { exact: true })).toBeVisible();
  await expect(open!.getByRole("button", { name: "Accept" })).toBeEnabled();
  await expect(open!.getByRole("button", { name: "Decline" })).toBeEnabled();
  await expect(declined!.getByText("Declined", { exact: true })).toBeVisible();
  await open!.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "tool-question-card");
});

test("gallery shows routine changes as small rows", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?scenario=routines&theme=light");
  const rows = page.getByTestId("routine-event-row");
  await expect(rows).toHaveText([
    'Created routine "Morning stretch"',
    'Updated routine "Morning stretch"',
    'Updated routine "Morning stretch"',
    'Disabled routine "Morning stretch"',
    'Enabled routine "Morning stretch"',
    'Deleted routine "Morning stretch"',
  ]);
  await captureScreenshot(page, testInfo, "routine-change-rows");
});

test("gallery renders every chat scenario in both themes", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e/fixtures/gallery.html?theme=light");
  const nav = page.getByRole("navigation");
  const scenarios = await nav.locator("button:not([aria-pressed])").all();
  expect(scenarios.length).toBeGreaterThan(5);

  for (const scenario of scenarios) {
    const label = (await scenario.textContent())!;
    await scenario.click();
    await expect(scenario).toHaveAttribute("aria-current", "page");
    for (const theme of ["light", "dark"]) {
      const dark = nav.getByRole("button", { name: "Dark" });
      if ((await dark.getAttribute("aria-pressed")) !== String(theme === "dark"))
        await dark.click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("gallery-frame")).not.toBeEmpty();
      if (label === "Rich content") {
        // Both load after mount and fall back quietly, so wait for the real content.
        await expect(page.locator("svg[class^='plot-']")).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator('img[alt="whiteboard.svg"]')
              .evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBeGreaterThan(0);
      }
      await captureScreenshot(
        page,
        testInfo,
        `gallery-${label.toLowerCase().replaceAll(" ", "-")}-${theme}`,
      );
    }
  }

  await nav.getByRole("button", { name: "Questions" }).click();
  await nav.getByRole("button", { name: "Phone width" }).click();
  const phone = page.frameLocator('iframe[title="Phone preview"]');
  await expect(phone.getByText("Which city should I use?")).toBeVisible();
  expect(
    await phone.locator("main").evaluate((element) => element.getBoundingClientRect().width),
  ).toBe(390);
  await captureScreenshot(page, testInfo, "gallery-questions-phone");
  expect(errors).toEqual([]);
});
