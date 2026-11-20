import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { completeOnboarding, signup } from "../helpers/helpers";

async function toggleGeometry(button: Locator) {
  const icon = button.locator("svg");
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect(icon).toHaveCSS("width", "18px");
  return icon.evaluate((svg) => {
    const [divider, chevron] = svg.querySelectorAll("path");
    if (!divider || !chevron) throw new Error("Missing toggle icon paths");
    const xAt = (path: SVGPathElement, fraction: number) => {
      const transform = path.getScreenCTM();
      if (!transform) throw new Error("Missing icon path transform");
      const point = path.getPointAtLength(path.getTotalLength() * fraction);
      return point.matrixTransform(transform).x;
    };
    const { left, right } = svg.getBoundingClientRect();
    return {
      divider: Math.sign(xAt(divider, 0.5) - (left + right) / 2),
      arrow: Math.sign(xAt(chevron, 0.5) - xAt(chevron, 0)),
    };
  });
}

for (const direction of ["ltr", "rtl"] as const) {
  test(`sidebar toggle icons follow the sidebar in ${direction}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1400, height: 900 });
    await signup(
      page,
      `sidebar-icons-${direction}-${Date.now()}@rakazo.test`,
      "password12",
      "Sidebar Icons",
    );
    await completeOnboarding(page);
    await page.evaluate((dir) => {
      document.documentElement.dir = dir;
    }, direction);
    // The resize also renders the sidebar on the side selected by the new document direction.
    await page.setViewportSize({ width: 1300, height: 900 });

    const sidebar = page.getByTestId("bots-sidebar");
    const right = direction === "rtl";
    const side = right ? 1 : -1;
    await expect
      .poll(async () => {
        const box = await sidebar.boundingBox();
        return box ? Math.round(right ? box.x + box.width : box.x) : null;
      })
      .toBe(right ? 1300 : 0);

    const minimize = sidebar.getByTestId("minimize-bots-sidebar");
    await expect(minimize).toHaveAccessibleName("Minimize bots");
    expect(await toggleGeometry(minimize)).toEqual({ divider: side, arrow: side });
    await minimize.press("Enter");
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");

    const restore = sidebar.getByTestId("restore-bots-sidebar");
    await expect(restore).toHaveAccessibleName("Show bots");
    expect(await toggleGeometry(restore)).toEqual({ divider: side, arrow: -side });
    await restore.click();
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  });
}
