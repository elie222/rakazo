import { expect, test } from "@playwright/test";

test("organic avatar path stays still when reduced motion is enabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/e2e/fixtures/avatar-motion.html");

  const avatar = page.locator(".rakazo-organic-avatar");
  await expect(avatar).toBeVisible();
  await expect(avatar.locator("animate")).toHaveCount(0);

  const body = avatar.locator(".rakazo-organic-avatar-body-working");
  const snapshot = () =>
    body.evaluate((path: SVGPathElement) => ({
      animationName: getComputedStyle(path).animationName,
      d: getComputedStyle(path).d,
      length: path.getTotalLength(),
    }));
  const first = await snapshot();
  await page.waitForTimeout(300);
  const second = await snapshot();

  expect(first.animationName).toBe("none");
  expect(second).toEqual(first);
});
