import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";

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

test.describe("Grok Bot alternative", () => {
  test("page publishes one heading, canonical URL, and matching FAQ data", async ({ page }, testInfo) => {
    await page.goto("/grok-bot-alternative/");
    await page.waitForLoadState("load");

    await expect(page).toHaveTitle(
      "Open Source Grok Bot Alternative (Self-Hosted) – Rakazo",
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      /open source, self-hosted Grok Bot alternative/,
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      "Open Source Grok Bot Alternative (Self-Hosted) – Rakazo",
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      /^https:\/\/rakazo\.com\/grok-bot-alternative\/?$/,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      /^https:\/\/rakazo\.com\/grok-bot-alternative\/?$/,
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Open source, self-hosted Grok Bot alternative",
    );
    await expect(page.getByRole("heading", { name: "Is Grok Bot open source?" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Can I self-host Grok Bot?" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "How is Rakazo different from Grok Bot?" }),
    ).toBeVisible();

    const jsonLd = await page.locator('script[type="application/ld+json"]').textContent();
    expect(jsonLd).toContain('"@type":"FAQPage"');
    expect(jsonLd).toContain("Is Grok Bot open source?");
    expect(jsonLd).toContain("Can I self-host Grok Bot?");
    expect(jsonLd).toContain("How is Rakazo different from Grok Bot?");
    expect(jsonLd).toContain("does not publish its source for you to run");

    await expect(page.locator(".site-nav").getByRole("link", { name: "Grok Bot" })).toBeVisible();
    const footerGrok = page
      .locator(".site-footer__links")
      .getByRole("link", { name: "Grok Bot alternative" });
    await expect(footerGrok).toBeVisible();
    await expect(footerGrok).toHaveAttribute("aria-current", "page");
    await expect(
      page.locator(".site-footer__languages").getByRole("link", { name: "English" }),
    ).not.toHaveAttribute("aria-current", "page");
    await expect(page.locator("footer [aria-current='page']")).toHaveCount(1);

    const docs = page.getByRole("link", { name: "Read the docs" });
    await expect(docs).toHaveCSS("color", "rgb(255, 255, 255)");
    const sources = page.locator("ul.source-list");
    await expect(sources).toHaveCSS("display", "flex");
    await expect(sources).toHaveCSS("font-size", "14px");
    await expect(sources.getByRole("link", { name: "Grok Bot overview" })).toBeVisible();

    await captureScreenshot(page, testInfo, "05-grok-bot-alternative");

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(docs).toHaveCSS("color", "rgb(255, 255, 255)");
    await captureScreenshot(page, testInfo, "05-grok-bot-alternative-dark");
  });

  test("homepage headings name the open source alternative", async ({ page }, testInfo) => {
    await page.goto("/");
    await page.waitForLoadState("load");

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "The open source Grok Bot alternative you actually own",
    );
    await expect(page.locator("#selfhost").getByRole("heading", { level: 2 })).toHaveText(
      "Self-hosted. The computer is yours.",
    );
    await expect(page.locator("#open-source").getByRole("heading", { level: 2 })).toHaveText(
      "Open source. Just the repo.",
    );
    await expect(page.locator(".site-nav").getByRole("link", { name: "Grok Bot" })).toHaveAttribute(
      "href",
      "/grok-bot-alternative/",
    );
    await expect(
      page.locator(".site-footer__languages").getByRole("link", { name: "English" }),
    ).toHaveAttribute("aria-current", "page");

    await captureScreenshot(page, testInfo, "06-marketing-homepage-headings");
  });
});
