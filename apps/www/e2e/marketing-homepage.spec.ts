import { expect, type Page, type TestInfo, test } from "@playwright/test";

async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: screenshotPath,
  });
  await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
}

test.describe("marketing homepage", () => {
  test("self-host is short CTAs, not an install script", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.waitForLoadState("load");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const selfHost = page.locator("#selfhost");
    await expect(selfHost).toBeVisible();
    await expect(selfHost.getByRole("heading", { level: 2 })).toBeVisible();
    await expect(selfHost.getByRole("button", { name: /Get started/i })).toBeVisible();
    await expect(selfHost.getByRole("link", { name: /View on GitHub/i })).toBeVisible();
    await expect(selfHost.getByRole("link", { name: /Read the docs/i })).toBeVisible();

    await expect(selfHost.locator("pre")).toHaveCount(0);
    await expect(selfHost).not.toContainText(
      /openssl|docker-compose\.images|POSTGRES_PASSWORD|BETTER_AUTH_SECRET|mkdir rakazo/i,
    );

    await expect(async () => {
      await selfHost.scrollIntoViewIfNeeded();
    }).toPass({ timeout: 15_000 });
    await captureScreenshot(page, testInfo, "01-marketing-homepage-selfhost");

    await expect(async () => {
      await selfHost.getByRole("button", { name: /Get started/i }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    }).toPass();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toBeVisible();
    await expect(dialog).not.toContainText(
      /openssl|docker-compose\.images|POSTGRES_PASSWORD|BETTER_AUTH_SECRET|mkdir rakazo/i,
    );
    await captureScreenshot(page, testInfo, "02-marketing-get-started");
  });

  test("zh homepage matches the simplified self-host CTAs", async ({ page }, testInfo) => {
    await page.goto("/zh/");
    await page.waitForLoadState("load");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("真正属于你的 AI 队友");
    const selfHost = page.locator("#selfhost");
    await expect(selfHost).toBeVisible();
    await expect(selfHost.getByRole("heading", { level: 2 })).toHaveText("电脑归你所有");
    await expect(selfHost.getByRole("button", { name: "开始使用" })).toBeVisible();
    await expect(selfHost.getByRole("link", { name: "在 GitHub 上查看" })).toBeVisible();
    await expect(selfHost.getByRole("link", { name: "阅读文档" })).toBeVisible();

    await expect(selfHost.locator("pre")).toHaveCount(0);
    await expect(selfHost).not.toContainText(
      /openssl|docker-compose\.images|POSTGRES_PASSWORD|BETTER_AUTH_SECRET|mkdir rakazo/i,
    );

    await expect(async () => {
      await selfHost.scrollIntoViewIfNeeded();
    }).toPass({ timeout: 15_000 });
    await captureScreenshot(page, testInfo, "03-marketing-homepage-zh-selfhost");

    await expect(async () => {
      await selfHost.getByRole("button", { name: "开始使用" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    }).toPass();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText("你想如何开始？");
    await expect(dialog).not.toContainText(
      /openssl|docker-compose\.images|POSTGRES_PASSWORD|BETTER_AUTH_SECRET|mkdir rakazo/i,
    );
    await captureScreenshot(page, testInfo, "04-marketing-zh-get-started");
  });
});
