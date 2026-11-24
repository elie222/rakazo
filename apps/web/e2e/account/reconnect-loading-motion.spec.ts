import { expect, test } from "@playwright/test";
import { captureScreenshot } from "../helpers/helpers";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`reconnect loading follows the motion preference: ${reducedMotion}`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion });
    await page.route("**/api/auth/get-session**", (route) =>
      route.fulfill({ status: 503, json: { message: "Simulated outage" } }),
    );
    await page.goto("/app");

    const label = page.getByText("Reconnecting", { exact: true });
    await expect(label).toBeVisible();
    const pixels = label.locator("xpath=../..").locator('[aria-hidden="true"] > span');
    await expect(pixels).toHaveCount(9);
    const reduce = reducedMotion === "reduce";
    await expect(label).toHaveCSS("animation-name", reduce ? "none" : "bui-shimmer-text");
    await expect
      .poll(() =>
        pixels.evaluateAll((elements) => elements.map((el) => getComputedStyle(el).animationName)),
      )
      .toEqual(Array(9).fill(reduce ? "none" : "bui-pixel-on"));

    if (reduce) {
      await expect(label).toHaveCSS("background-image", "none");
      await expect(label).not.toHaveCSS("color", "rgba(0, 0, 0, 0)");
    } else {
      await expect(label).toHaveCSS("background-image", /linear-gradient/);
    }
    await expect(page.getByText("Can't reach the server.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry now" })).toBeEnabled();
    await captureScreenshot(page, testInfo, `reconnect-loading-${reducedMotion}`);
  });
}
