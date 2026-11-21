import { expect, test } from "@playwright/test";

test("paging an expanded Markdown table resets only its vertical scroll", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 220 });
  await page.goto("/e2e/fixtures/markdown-table.html?stream=1&tall=1");

  const card = page.getByTestId("table-card");
  await expect(card).toBeVisible();
  // Enough columns to overflow even when the expanded dialog wraps long cell text.
  const columns = ["Item", ...Array.from({ length: 27 }, (_, index) => `Column ${index + 1}`)];
  const markdown = [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...Array.from({ length: 25 }, (_, index) => `| item-${index + 1} |${" Sample |".repeat(27)}`),
  ].join("\n");
  await page.evaluate((text) => {
    window.dispatchEvent(new CustomEvent("rk-table-stream-update", { detail: { markdown: text } }));
  }, markdown);
  await expect(card.getByText("1–10 of 25 rows")).toBeVisible();
  await card.getByRole("button", { name: "Expand table" }).click();

  const dialog = page.getByRole("dialog", { name: "Table" });
  const viewport = dialog.locator(".rk-table-dialog-scroll");
  const pageScroll = await page.evaluate(() => window.scrollY);
  const scrolled = await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.scrollLeft = 100;
    return { top: element.scrollTop, left: element.scrollLeft };
  });
  expect(scrolled.top).toBeGreaterThan(0);
  expect(scrolled.left).toBeGreaterThan(0);

  await dialog.getByRole("button", { name: "Next page" }).click();
  await expect(dialog.getByText("11–20 of 25 rows")).toBeVisible();
  await expect(dialog.locator("tbody tr").first()).toContainText("item-11");
  await expect
    .poll(() =>
      viewport.evaluate((element) => ({ top: element.scrollTop, left: element.scrollLeft })),
    )
    .toEqual({ top: 0, left: scrolled.left });

  expect(
    await viewport.evaluate((element) => {
      const row = element.querySelector("tbody tr")!.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      return row.bottom > bounds.top && row.top < bounds.bottom;
    }),
  ).toBe(true);

  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await dialog.getByRole("button", { name: "Previous page" }).click();
  await expect(dialog.getByText("1–10 of 25 rows")).toBeVisible();
  await expect(dialog.locator("tbody tr").first()).toContainText("item-1");
  await expect
    .poll(() =>
      viewport.evaluate((element) => ({ top: element.scrollTop, left: element.scrollLeft })),
    )
    .toEqual({ top: 0, left: scrolled.left });
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll);
});
