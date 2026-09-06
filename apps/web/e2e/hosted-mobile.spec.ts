import { expect, test } from "@playwright/test";
import { captureScreenshot, openNewBot, signup } from "./helpers";

for (const width of [320, 375, 768]) {
  test(`hosted worker creation and draft handoff at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 812 });
    await signup(
      page,
      `hosted-mobile-${width}-${Date.now()}@example.com`,
      "password12345",
      "Mobile tester",
    );
    await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
    // Exercise hosted entry with the real local data API and a configured model.
    // Only hosted availability is substituted; local account auth stays unchanged.
    await page.route("**/api/auth/capabilities", (route) =>
      route.fulfill({
        json: {
          provider: "local",
          hosted: true,
          companyOsOrigin: null,
          passwordReset: false,
          resetUrl: null,
        },
      }),
    );
    await page.goto("/app?task=Prepare%20a%20research%20brief%20for%20review.");
    await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Connect a model" })).toHaveCount(0);
    await page.locator("label:has-text('Name') input").fill("Researcher");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Message Researcher" })).toHaveValue(
      "Prepare a research brief for review.",
    );
    await expect(page.getByRole("button", { name: "Workforce", exact: true })).toHaveCount(0);
    await captureScreenshot(page, testInfo, `hosted-chat-${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const input = page.getByRole("combobox", { name: "Message Researcher" });
    const box = await input.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    if (width < 768) {
      await expect(page.locator("aside").first()).toHaveAttribute("inert", "");
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await expect(page.locator("aside").first()).not.toHaveAttribute("inert", "");
    }
    await openNewBot(page);
    await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
    await expect(page.getByPlaceholder("Message New Bot")).toHaveValue("");
    // Creating a worker closes the mobile drawer and leaves its composer usable.
    if (width < 768) await expect(page.locator("aside").first()).toHaveAttribute("inert", "");
    await page
      .getByRole("combobox", { name: "Message New Bot" })
      .fill("Keep working until I stop you");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible();
    const stopBox = await stop.boundingBox();
    expect(stopBox!.x + stopBox!.width).toBeLessThanOrEqual(width);
    const inputBox = await page.getByRole("combobox", { name: "Message New Bot" }).boundingBox();
    const sendBox = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
    const overlapX = Math.max(
      0,
      Math.min(inputBox!.x + inputBox!.width, sendBox!.x + sendBox!.width) -
        Math.max(inputBox!.x, sendBox!.x),
    );
    const overlapY = Math.max(
      0,
      Math.min(inputBox!.y + inputBox!.height, sendBox!.y + sendBox!.height) -
        Math.max(inputBox!.y, sendBox!.y),
    );
    expect(overlapX * overlapY).toBe(0);
    await captureScreenshot(page, testInfo, `hosted-running-${width}`);
    await stop.click();
    await expect(stop).toBeHidden();
    if (width < 768) {
      await page.getByTitle("Agent computer").click();
      await expect(page.getByTestId("computer-chrome")).toBeVisible();
      await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await captureScreenshot(page, testInfo, `hosted-computer-${width}`);
      await page.getByRole("button", { name: "Release", exact: true }).click();
    }
    await page.locator("main").getByRole("button", { name: "New Bot", exact: true }).click();
    await expect(page.getByTestId("bot-settings")).toBeVisible();
    await captureScreenshot(page, testInfo, `hosted-settings-${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
