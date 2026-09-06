import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/chart-links.html";

test("chart links cannot execute script when clicked or expanded", async ({ page }, testInfo) => {
  for (const inspect of ["0", "1"]) {
    for (const href of [
      'javascript:void(document.body.dataset.plotExecuted="yes")',
      ' \u0000\u001fJaVa\tScRi\nPt:void(document.body.dataset.plotExecuted="yes")',
      'javascript:%76oid(document.body.dataset.plotExecuted="yes")',
      "data:text/html,<script>document.body.dataset.plotExecuted='yes'</script>",
      "file:///example.txt",
    ]) {
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
  }
  await captureScreenshot(page, testInfo, "chart-with-inert-link");
});

test("chart links retain supported URLs and browser encoding semantics", async ({ page }) => {
  await page.route("https://example.test/**", (route) =>
    route.fulfill({ body: "Chart destination" }),
  );
  await page.route("**/e2e/fixtures/java*", (route) =>
    route.fulfill({ body: "Chart destination" }),
  );
  for (const href of [
    "https://example.test/chart?a=1&b=2",
    "mailto:chart@example.test",
    "tel:+15555550123",
    "#details",
    "java&#x73;cript:void(0)",
    "javascript%3Avoid(0)",
    "java%73cript:void(0)",
  ]) {
    await page.goto(`${fixture}?${new URLSearchParams({ href })}`);
    const link = page.locator("svg a").first();
    await expect(link).toBeVisible();
    expect(
      await link.evaluate((anchor) =>
        anchor.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
      ),
    ).toBe(href);
    const destination = new URL(href, page.url());
    expect(destination.protocol).not.toBe("javascript:");
    if (destination.protocol === "http:" || destination.protocol === "https:") {
      await link.locator("circle").click();
      await expect(page).toHaveURL(destination.href);
      await expect(page.locator("body")).not.toHaveAttribute("data-plot-executed");
    }
  }
});
