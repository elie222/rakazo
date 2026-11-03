import type { Page, TestInfo } from "@playwright/test";
import { devices, test } from "@playwright/test";

// The hero and closing call to action pick actions for the visitor's platform; record the macOS and iPhone variants.
const { defaultBrowserType: _, ...iPhone } = devices["iPhone 15"];
test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});

async function openHomepage(page: Page, path = "/") {
  await page.goto(path);
  // The server-rendered demo is visible before its client listeners are ready.
  await page
    .locator('astro-island[component-export="ProductDemo"]:not([ssr])')
    .waitFor({ state: "attached" });
}

// The gallery rejects images taller than 10,000px, so long pages are split into parts.
const MAX_SCREENSHOT_HEIGHT = 9_000;

/** Visual record for the CI screenshot gallery. No content assertions. */
async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const { width, height } = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight,
  }));
  const parts = Math.ceil(height / MAX_SCREENSHOT_HEIGHT);
  for (let part = 0; part < parts; part++) {
    const partName = part === 0 ? name : `${name}-${part + 1}`;
    const screenshotPath = testInfo.outputPath(`${partName}.png`);
    const y = part * MAX_SCREENSHOT_HEIGHT;
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage: true,
      scale: "css",
      clip: { x: 0, y, width, height: Math.min(MAX_SCREENSHOT_HEIGHT, height - y) },
      path: screenshotPath,
    });
    await testInfo.attach(partName, { contentType: "image/png", path: screenshotPath });
  }
}

async function openAnsweredOnboarding(page: Page) {
  await page.locator('.product-demo[data-product-demo-ready="true"]').waitFor();
  const demo = page.locator(".product-demo");
  const showBots = demo.getByRole("button", { name: "Show bots", exact: true });
  if (await showBots.isVisible()) await showBots.click();
  await demo.getByRole("button", { name: "New bot", exact: true }).click();
  await demo.getByRole("button", { name: "Close panel", exact: true }).click();
  await demo.getByRole("button", { name: "A Inbox & email", exact: true }).click();
  await demo.getByRole("button", { name: "B Warm and conversational", exact: true }).click();
  await demo.locator(".product-demo__choice--done").last().scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
}

test("homepage screenshots", async ({ page }, testInfo) => {
  await openHomepage(page);
  await captureScreenshot(page, testInfo, "01-marketing-homepage");


  await openHomepage(page, "/zh/");
  await captureScreenshot(page, testInfo, "03-marketing-homepage-zh");

  await openHomepage(page, "/ja/");
  await captureScreenshot(page, testInfo, "03-marketing-homepage-ja");

  await openHomepage(page, "/he/");
  await captureScreenshot(page, testInfo, "03-marketing-homepage-he");

  await openHomepage(page);
  await page
    .locator('.product-demo[data-product-demo-ready="true"]')
    .waitFor({ state: "attached" });
  await page.locator(".product-demo__computer-shot").first().click();
  await page.locator(".product-demo__takeover").waitFor({ state: "visible" });
  await captureScreenshot(page, testInfo, "04-marketing-demo-computer");
  await page.keyboard.press("Escape");
  await openAnsweredOnboarding(page);
  await captureScreenshot(page, testInfo, "05-marketing-demo-onboarding");
});

test.describe("on an iPhone", () => {
  test.use(iPhone);

  test("homepage screenshot", async ({ page }, testInfo) => {
    await openHomepage(page);
    await captureScreenshot(page, testInfo, "02-marketing-homepage-iphone");
    await openAnsweredOnboarding(page);
    await captureScreenshot(page, testInfo, "06-marketing-demo-onboarding-iphone");
  });
});

test("plugin pages screenshots", async ({ page }, testInfo) => {
  await page.goto("/plugins/submit/");
  await captureScreenshot(page, testInfo, "07-marketing-plugin-submit");
  await page.goto("/docs/build-a-plugin/");
  await captureScreenshot(page, testInfo, "08-marketing-docs-build-a-plugin");
});
