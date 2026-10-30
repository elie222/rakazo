import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/markdown-diagram.html";

const flowSource = [
  "graph LR",
  "  A[Clone repo] --> B[Branch] --> C[Tests] --> D[Pull request]",
].join("\n");

async function streamUpdate(page: Page, markdown: string, streaming: boolean) {
  await page.evaluate(
    (detail) => {
      window.dispatchEvent(new CustomEvent("rk-diagram-stream-update", { detail }));
    },
    { markdown, streaming },
  );
}

async function diagramMarkup(page: Page) {
  const src = await page.getByTestId("chat-diagram").locator("img").getAttribute("src");
  return decodeURIComponent(src?.slice(src.indexOf(",") + 1) ?? "");
}

async function expectDrawn(page: Page) {
  const image = page.getByTestId("chat-diagram").locator("img");
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth))
    .toBeGreaterThan(0);
  return image;
}

test("a mermaid fence is drawn as a themed, copyable diagram in place of its code block", async ({
  page,
}, testInfo) => {
  await page.goto(fixture);
  const message = page.getByTestId("diagram-fixture");
  const image = await expectDrawn(page);

  await expect(image).toHaveAttribute("alt", "Diagram");
  await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml;/);
  await expect(message.locator("pre")).toHaveCount(0);
  await expect(message.getByText("graph LR")).toHaveCount(0);
  const text = await message.innerText();
  expect(text.indexOf("Here is the contribution flow:")).toBeLessThan(
    text.indexOf("Each step runs in CI."),
  );
  const drawnText = (await diagramMarkup(page)).replace(/<[^>]+>/g, "");
  for (const label of ["Clone repo", "Branch", "Tests", "Pull request"]) {
    expect(drawnText).toContain(label);
  }
  const frame = await message.boundingBox();
  const drawn = await image.boundingBox();
  expect(drawn!.width).toBeLessThanOrEqual(frame!.width);

  await captureScreenshot(page, testInfo, "markdown-diagram-dark");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy diagram source" }).click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(flowSource);
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();

  expect(await diagramMarkup(page)).toContain("fill:#F5F5F5");
  await page.goto(`${fixture}?theme=light`);
  await expectDrawn(page);
  expect(await diagramMarkup(page)).toContain("fill:#1C1C1C");
  await captureScreenshot(page, testInfo, "markdown-diagram-light");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect.poll(() => diagramMarkup(page)).toContain("fill:#F5F5F5");
});

test("a wide diagram scrolls on a phone instead of shrinking its text away", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture}?case=wide`);
  const image = await expectDrawn(page);
  const natural = await image.evaluate((node: HTMLImageElement) => node.width && node.naturalWidth);
  const shown = (await image.boundingBox())!.width;
  expect(shown).toBeGreaterThanOrEqual(Math.floor(natural * 0.8) - 1);
  const card = page.getByTestId("chat-diagram");
  expect(await card.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "markdown-diagram-wide-phone");
});

test("Mermaid loads only for a message with a diagram", async ({ page }) => {
  // The library itself, not this package's own mermaid*.ts modules or the fixture.
  const libraryRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/mermaid/i.test(path) && !/chat-ui\/src\/|e2e\/fixtures\//.test(path)) {
      libraryRequests.push(path);
    }
  });
  await page.goto(`${fixture}?case=plain`);
  await expect(page.getByTestId("diagram-fixture").locator("pre")).toContainText("const ok");
  expect(libraryRequests).toEqual([]);

  await streamUpdate(page, `\`\`\`mermaid\n${flowSource}\n\`\`\``, false);
  await expectDrawn(page);
  expect(libraryRequests.length).toBeGreaterThan(0);
});
