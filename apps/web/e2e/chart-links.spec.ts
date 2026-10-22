import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/chart-links.html";

// The full matrix of unsafe and supported schemes lives in plot-tool.test.ts;
// this checks one obfuscated href stays inert in a real browser.
const href = ' \u0000\u001fJaVa\tScRi\nPt:void(document.body.dataset.plotExecuted="yes")';

test("chart links cannot execute script when clicked or expanded", async ({ page }, testInfo) => {
  for (const inspect of ["0", "1"]) {
    await page.goto(`${fixture}?${new URLSearchParams({ href, inspect })}`);
    const circle = page.locator("svg circle").first();
    await expect(circle).toBeVisible();
    const assertInert = async () => {
      const links = page.locator("svg a");
      expect(await links.count()).toBeGreaterThan(0);
      expect(
        await links.evaluateAll((anchors) =>
          anchors.every(
            (anchor) =>
              !anchor.hasAttribute("href") &&
              !anchor.hasAttributeNS("http://www.w3.org/1999/xlink", "href"),
          ),
        ),
      ).toBe(true);
      await expect(page.locator("body")).not.toHaveAttribute("data-plot-executed");
    };
    await assertInert();
    await circle.click();
    // Hover inspection still works, without reintroducing unsafe links.
    if (inspect === "1") await expect(page.locator('[aria-label="tip"]')).toBeVisible();
    await assertInert();
    await page.getByRole("button", { name: "Expand", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("svg circle")).toBeVisible();
    await dialog.locator("svg circle").click();
    await assertInert();
    await expect(page).toHaveURL(`${fixture}?${new URLSearchParams({ href, inspect })}`);
    await page.getByRole("button", { name: "Close chart" }).click();
  }
  await captureScreenshot(page, testInfo, "chart-with-inert-link");
});
