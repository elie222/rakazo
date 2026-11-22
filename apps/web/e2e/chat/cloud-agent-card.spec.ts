import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

test("long task labels wrap inside the card and keep the status visible", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/e2e/fixtures/gallery.html?embed&scenario=working");
  const card = page
    .getByTestId("cloud-agent-card")
    .filter({ has: page.getByText("running", { exact: true }) });
  await expect(card).toBeVisible();

  const overflowing = await card.evaluate((element) => {
    // Swap in an unbroken label so the real card CSS has to wrap it.
    const long = "ProjectIdentifier".repeat(8);
    const [title, branch] = element.querySelectorAll('[dir="auto"]');
    title!.textContent = long;
    branch!.textContent = `feature/${long}`;
    const bounds = element.getBoundingClientRect();
    return [title!, branch!, element.querySelector('[data-slot="badge"]')!]
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.left < bounds.left - 1 || rect.right > bounds.right + 1).length;
  });
  expect(overflowing).toBe(0);

  await card.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "cloud-agent-card-long-labels");
});
