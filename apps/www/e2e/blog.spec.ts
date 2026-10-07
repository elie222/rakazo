import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";

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

test.describe("blog", () => {
  test("index lists the posts and a post has dates, a table, and structured data", async ({
    page,
  }, testInfo) => {
    await page.goto("/blog/");
    await expect(page.getByRole("heading", { level: 1, name: "Blog" })).toBeVisible();
    await expect(page.locator(".site-nav").getByRole("link", { name: "Blog" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("link", { name: /Best open source AI agents in 2026/ })).toBeVisible();
    await captureScreenshot(page, testInfo, "07-blog-index");

    await page.goto("/blog/best-open-source-ai-agents-2026/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Best open source AI agents in 2026",
    );
    await expect(page.locator(".post-meta")).toContainText("Published October 7, 2026");
    await expect(page.locator(".post-meta")).toContainText("Updated October 7, 2026");
    await expect(page.locator(".post-meta")).toContainText("Elie Steinbock");
    await expect(page.getByRole("heading", { name: "TL;DR" })).toBeVisible();
    await expect(page.getByRole("table").getByRole("columnheader", { name: "License" })).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/blog/best-open-source-ai-agents-2026/",
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      /\/og\/blog-best-open-source-ai-agents-2026\.png$/,
    );
    await expect(page.locator('link[rel="alternate"][type="application/rss+xml"]')).toHaveAttribute(
      "href",
      "/blog/rss.xml",
    );

    const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    const parsed = scripts.map((script) => JSON.parse(script) as { "@type"?: string; "@graph"?: Array<{ "@type"?: string }> });
    expect(parsed.some((entry) => entry["@graph"]?.some((node) => node["@type"] === "BlogPosting"))).toBe(
      true,
    );
    expect(parsed.some((entry) => entry["@graph"]?.some((node) => node["@type"] === "BreadcrumbList"))).toBe(
      true,
    );
    expect(parsed.some((entry) => entry["@type"] === "FAQPage")).toBe(true);
    await captureScreenshot(page, testInfo, "07-blog-post");

    await page.goto("/blog/roundups/");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  });

  test("rss lists the posts", async ({ page }) => {
    const response = await page.goto("/blog/rss.xml");
    expect(response?.headers()["content-type"]).toContain("application/rss+xml");
    const body = await response?.text();
    expect(body).toContain("Best open source AI agents in 2026");
    expect(body).toContain("OpenClaw vs Hermes Agent vs Rakazo");
    expect(body).toContain("How to self-host an AI agent in 10 minutes");
  });
});
