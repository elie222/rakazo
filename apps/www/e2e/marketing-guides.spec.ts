import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
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

async function expectFaqMatchesVisibleCopy(page: Page) {
  const raw = await page.locator('script[type="application/ld+json"]').textContent();
  expect(raw).toBeTruthy();
  const data = JSON.parse(raw ?? "") as {
    "@type": string;
    mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
  };
  expect(data["@type"]).toBe("FAQPage");
  expect(data.mainEntity.length).toBeGreaterThan(0);
  for (const item of data.mainEntity) {
    await expect(page.getByRole("heading", { level: 3, name: item.name })).toBeVisible();
    await expect(
      page.getByText(visibleInlineCode(item.acceptedAnswer.text), { exact: true }).first(),
    ).toBeVisible();
  }
}

test.describe("marketing guides", () => {
  test("homepage keeps its title and links the new pages", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("load");

    await expect(page).toHaveTitle("Rakazo | Open source Grok Bot alternative");
    await expect(page.locator('link[hreflang="de-DE"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/de/",
    );
    await expect(page.locator('link[hreflang="ko-KR"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/ko/",
    );
    await expect(page.locator('link[hreflang="zh-CN"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/zh/",
    );
    await expect(page.locator('link[hreflang="x-default"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/",
    );

    const footer = page.locator("footer");
    await expect(footer.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "/self-hosted-ai-agent/",
    );
    await expect(footer.getByRole("link", { name: "OpenClaw alternative" })).toHaveAttribute(
      "href",
      "/openclaw-alternative/",
    );
    await expect(page.locator("#selfhost").getByRole("link", { name: "Read the docs" })).toHaveAttribute(
      "href",
      "/self-hosted-ai-agent/",
    );
    await expect(
      page.locator("#open-source").getByRole("link", { name: "OpenClaw alternative" }),
    ).toHaveAttribute("href", "/openclaw-alternative/");
  });

  test("self-host guide renders one heading, FAQ, and canonical tags", async ({ page }, testInfo) => {
    await page.goto("/self-hosted-ai-agent/");
    await page.waitForLoadState("load");

    await expect(page).toHaveTitle("Self-Hosted AI Agent (Open Source) – Rakazo");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Self-hosted AI agent");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /.+/);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      "Self-Hosted AI Agent (Open Source) – Rakazo",
    );
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", /.+/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/self-hosted-ai-agent/",
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      "https://rakazo.com/self-hosted-ai-agent/",
    );
    await expect(page.locator('link[hreflang="de-DE"]')).toHaveCount(0);
    await expect(page.locator('link[hreflang="ko-KR"]')).toHaveCount(0);
    await expect(page.locator('link[hreflang="zh-CN"]')).toHaveCount(0);
    await expect(page.locator('meta[property="og:locale:alternate"]')).toHaveCount(0);
    const licenseParagraph = page.locator("main p").filter({ hasText: "Apache-2.0" });
    await expect(licenseParagraph).toContainText("Hosted Rakazo Cloud is not generally available.");
    await expect(licenseParagraph.getByRole("link", { name: "Hosted Rakazo Cloud" })).toHaveCount(0);
    await expect(licenseParagraph.getByRole("link", { name: "Apache-2.0" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Get started" })).toHaveCSS(
      "color",
      "rgb(255, 255, 255)",
    );
    const reference = page.locator("ul.source-list");
    await expect(reference).toHaveCSS("display", "flex");
    await expect(reference).toHaveCSS("font-size", "14px");
    await expect(page.locator("footer [aria-current='page']")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "full self-hosting guide" })).toHaveAttribute(
      "href",
      /github\.com\/elie222\/rakazo\/blob\/main\/docs\/self-host\.md$/,
    );
    await expect(page.getByRole("link", { name: "OpenClaw comparison" })).toHaveAttribute(
      "href",
      "/openclaw-alternative/",
    );
    await expectFaqMatchesVisibleCopy(page);
    await captureScreenshot(page, testInfo, "05-self-hosted-ai-agent");

    await expect(page.locator("html")).toHaveAttribute("data-get-started-ready", "");
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page.locator("[data-get-started-dialog]")).toBeVisible();
  });

  test("OpenClaw comparison renders the table, FAQ, and cross-links", async ({ page }, testInfo) => {
    await page.goto("/openclaw-alternative/");
    await page.waitForLoadState("load");

    await expect(page).toHaveTitle("Open Source OpenClaw Alternative – Rakazo");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Open source OpenClaw alternative",
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /.+/);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      "Open Source OpenClaw Alternative – Rakazo",
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      "https://rakazo.com/openclaw-alternative/",
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      "https://rakazo.com/openclaw-alternative/",
    );
    await expect(page.locator('link[hreflang="de-DE"]')).toHaveCount(0);
    await expect(page.locator('meta[property="og:locale:alternate"]')).toHaveCount(0);
    const guide = page.getByRole("link", { name: "Self-host guide", exact: true });
    await expect(guide).toHaveCSS("color", "rgb(255, 255, 255)");
    const sources = page.locator("ul.source-list");
    await expect(sources).toHaveCSS("display", "flex");
    await expect(sources).toHaveCSS("font-size", "14px");
    await expect(page.locator("footer [aria-current='page']")).toHaveCount(1);
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Rakazo" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "OpenClaw" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Self-hosted AI agent guide" })).toHaveAttribute(
      "href",
      "/self-hosted-ai-agent/",
    );
    await expect(page.getByRole("list").getByRole("link", { name: "OpenClaw docs" })).toHaveAttribute(
      "href",
      "https://docs.openclaw.ai/",
    );
    await expectFaqMatchesVisibleCopy(page);
    await captureScreenshot(page, testInfo, "06-openclaw-alternative");
  });

  test("locale homepages stay routed and the guides are English-only", async ({ page }) => {
    await page.goto("/de/");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.locator('link[hreflang="en-US"]')).toHaveAttribute("href", "https://rakazo.com/");
    await expect(page.locator("footer").getByRole("link", { name: "OpenClaw-Alternative" })).toHaveAttribute(
      "href",
      "/openclaw-alternative/",
    );

    for (const path of [
      "/de/self-hosted-ai-agent/",
      "/ko/openclaw-alternative/",
      "/zh/self-hosted-ai-agent/",
    ]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    }
  });
});
