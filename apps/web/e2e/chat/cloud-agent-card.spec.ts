import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

function layout(card: Locator) {
  return card.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const [title, branch] = element.querySelectorAll('[dir="auto"]');
    const badge = element.querySelector('[data-slot="badge"]')!;
    const contained = (rect: DOMRect) =>
      rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
    const textLayout = (label: Element) => {
      const range = document.createRange();
      range.selectNodeContents(label);
      const lines = [...range.getClientRects()];
      return {
        contained: lines.length > 0 && lines.every(contained),
        wrapped: new Set(lines.map((line) => Math.round(line.top))).size > 1,
      };
    };
    return {
      badge: contained(badge.getBoundingClientRect()),
      title: textLayout(title!),
      branch: textLayout(branch!),
    };
  });
}

function setFixtureLabels(card: Locator, title: string, branch: string) {
  // Change only fixture text to exercise real card CSS without starting a task.
  return card.evaluate(
    (element, labels) => {
      const [titleLabel, branchLabel] = element.querySelectorAll('[dir="auto"]');
      titleLabel!.textContent = labels.title;
      branchLabel!.textContent = labels.branch;
    },
    { title, branch },
  );
}

for (const dir of ["ltr", "rtl"]) {
  test(`long task labels wrap without clipping the status at 320px in ${dir}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/e2e/fixtures/gallery.html?embed&scenario=working");
    await page.locator("html").evaluate((element, direction) => {
      element.dir = direction;
    }, dir);

    const running = page.getByText("running", { exact: true });
    const card = page.getByTestId("cloud-agent-card").filter({ has: running });
    await expect(card).toBeVisible();
    await setFixtureLabels(card, "Fix task", "fix/test");
    await expect
      .poll(() => layout(card))
      .toEqual({
        badge: true,
        title: { contained: true, wrapped: false },
        branch: { contained: true, wrapped: false },
      });

    const longLabel = "ProjectIdentifier".repeat(8);
    await setFixtureLabels(card, longLabel, `feature/${longLabel}`);
    await expect
      .poll(() => layout(card))
      .toEqual({
        badge: true,
        title: { contained: true, wrapped: true },
        branch: { contained: true, wrapped: true },
      });
    await card.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `cloud-agent-card-long-${dir}`);
  });
}
