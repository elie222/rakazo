import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { ALTERNATIVES, ALTERNATIVES_HUB, HUB_CARDS } from "../src/alternatives";
import { visibleInlineCode } from "../src/inline-code";

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

test.describe("alternatives", () => {
  test("hub lists every comparison and the footer links to it", async ({ page }, testInfo) => {
    await page.goto("/alternatives/");
    await page.waitForLoadState("load");

    await expect(page).toHaveTitle(ALTERNATIVES_HUB.title);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      ALTERNATIVES_HUB.description,
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ALTERNATIVES_HUB.h1);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      /^https:\/\/rakazo\.com\/alternatives\/?$/,
    );
    await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(0);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      ALTERNATIVES_HUB.title,
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      /^https:\/\/rakazo\.com\/alternatives\/?$/,
    );

    for (const card of HUB_CARDS) {
      await expect(page.getByRole("link", { name: card.h1 })).toHaveAttribute("href", card.href);
    }

    const footerHrefs = await page
      .locator(".site-footer__links a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(new Set(footerHrefs).size).toBe(footerHrefs.length);
    const headerHrefs = await page
      .locator(".site-nav a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(new Set(headerHrefs).size).toBe(headerHrefs.length);

    const footerAlternatives = page
      .locator(".site-footer__links")
      .getByRole("link", { name: "Alternatives" });
    await expect(footerAlternatives).toHaveAttribute("aria-current", "page");
    await expect(
      page.locator(".site-footer__languages").getByRole("link", { name: "English" }),
    ).not.toHaveAttribute("aria-current", "page");
    await expect(page.locator("footer [aria-current='page']")).toHaveCount(1);

    await expect(page.locator("ul.alt-index")).toHaveCSS("padding-left", "0px");
    await expect(page.getByRole("link", { name: "Self-hosting guide" })).toHaveCSS(
      "color",
      "rgb(255, 255, 255)",
    );

    await captureScreenshot(page, testInfo, "05-alternatives-hub");

    await page.goto("/");
    await page.locator(".site-nav").getByRole("link", { name: "Alternatives" }).click();
    await expect(page).toHaveURL(/\/alternatives\/?$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ALTERNATIVES_HUB.h1);
  });

  test("comparison pages keep one heading, canonical URL, and matching FAQ data", async ({
    page,
  }, testInfo) => {
    for (const [index, alternative] of ALTERNATIVES.entries()) {
      await page.goto(`/${alternative.slug}/`);
      await page.waitForLoadState("load");

      await expect(page).toHaveTitle(alternative.title);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        "content",
        alternative.description,
      );
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(alternative.h1);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        new RegExp(`^https://rakazo\\.com/${alternative.slug}/?$`),
      );
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
        "content",
        alternative.title,
      );
      await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
        "content",
        alternative.description,
      );
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
        "content",
        new RegExp(`^https://rakazo\\.com/${alternative.slug}/?$`),
      );
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
        "content",
        new RegExp(`/og/${alternative.slug}\\.png$`),
      );
      await expect(page.locator("p.page-updated")).toHaveText("Updated October 7, 2026.");
      await expect(page.locator("figure.vs-card")).toBeVisible();
      await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(0);
      await expect(page.locator('meta[property="og:locale:alternate"]')).toHaveCount(0);

      const table = page.getByRole("table");
      await expect(table).toBeVisible();
      await expect(table.getByRole("columnheader", { name: "Rakazo" })).toBeVisible();
      await expect(table.getByRole("columnheader", { name: alternative.otherName })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Why open source and self-hosted" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Get started" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Self-hosting guide" })).toHaveCSS(
        "color",
        "rgb(255, 255, 255)",
      );
      const sources = page.locator("ul.source-list");
      await expect(sources).toHaveCSS("display", "flex");
      await expect(sources).toHaveCSS("font-size", "14px");
      await expect(page.locator("p.alt-note").first()).toHaveCSS("font-size", "14.5px");

      const structuredData = JSON.parse(
        (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
      ) as {
        "@type"?: string;
        mainEntity?: Array<{ name?: string; acceptedAnswer?: { text?: string } }>;
      };
      expect(structuredData["@type"]).toBe("FAQPage");
      expect(structuredData.mainEntity?.map((item) => item.name)).toEqual(
        alternative.faq.map((item) => item.question),
      );
      expect(structuredData.mainEntity?.map((item) => item.acceptedAnswer?.text)).toEqual(
        alternative.faq.map((item) => item.answer),
      );
      for (const item of alternative.faq) {
        await expect(page.getByRole("heading", { name: item.question })).toBeVisible();
        await expect(page.getByText(visibleInlineCode(item.answer))).toBeVisible();
      }

      await captureScreenshot(page, testInfo, `06-alternative-${index}-${alternative.slug}`);
    }
  });

  test("localized homepages keep their hreflang alternates", async ({ page }) => {
    await page.goto("/de/");
    await expect(page.locator('link[rel="alternate"][hreflang="de-DE"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/de/",
    );
    await expect(page.locator('link[rel="alternate"][hreflang="ko-KR"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/ko/",
    );
    await expect(page.locator('link[rel="alternate"][hreflang="zh-CN"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/zh/",
    );
    await expect(page.locator('link[rel="alternate"][hreflang="en-US"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/",
    );
    await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/",
    );
    await expect(
      page.locator(".site-footer__links").getByRole("link", { name: "Alternativen" }),
    ).toHaveAttribute("href", "/alternatives/");
  });
});
