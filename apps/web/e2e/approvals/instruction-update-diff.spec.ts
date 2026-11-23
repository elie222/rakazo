import { expect, test } from "@playwright/test";

test("an instruction change shows only the changed lines", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/gallery.html?embed&scenario=approvals&theme=light");
  const card = page.getByTestId("instruction-approval-card");
  const detail = card.getByTestId("ask-detail");
  await expect(detail).toContainText("… 2 unchanged lines");
  await expect(detail).toContainText("- Summarize long threads in bullets.");
  await expect(detail).toContainText("+ Keep summaries to one paragraph.");
  await expect(detail).not.toContainText("Reply in English.");
  await card.scrollIntoViewIfNeeded();
  const screenshot = testInfo.outputPath("instruction-update-diff.png");
  await card.screenshot({ path: screenshot, animations: "disabled", caret: "hide" });
  await testInfo.attach("instruction-update-diff", { contentType: "image/png", path: screenshot });
});
