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

/** The SVG inside the diagram's data URL. */
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

test("a mermaid fence is drawn as a diagram in place of its code block", async ({
  page,
}, testInfo) => {
  await page.goto(fixture);
  const message = page.getByTestId("diagram-fixture");
  const image = await expectDrawn(page);

  await expect(image).toHaveAttribute("alt", "Diagram");
  await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml;/);
  await expect(message.locator("pre")).toHaveCount(0);
  await expect(message.getByText("graph LR")).toHaveCount(0);
  // The rest of the message keeps its order around the diagram.
  const text = await message.innerText();
  expect(text.indexOf("Here is the contribution flow:")).toBeLessThan(
    text.indexOf("Each step runs in CI."),
  );
  const drawnText = (await diagramMarkup(page)).replace(/<[^>]+>/g, "");
  for (const label of ["Clone repo", "Branch", "Tests", "Pull request"]) {
    expect(drawnText).toContain(label);
  }
  // Fits the message instead of widening it.
  const frame = await message.boundingBox();
  const drawn = await image.boundingBox();
  expect(drawn!.width).toBeLessThanOrEqual(frame!.width);

  await captureScreenshot(page, testInfo, "markdown-diagram-dark");
});

test("diagrams follow the app theme", async ({ page }, testInfo) => {
  // Diagram text is drawn in the theme's foreground token.
  await page.goto(fixture);
  await expectDrawn(page);
  expect(await diagramMarkup(page)).toContain("fill:#ECECEE");

  await page.goto(`${fixture}?theme=light`);
  await expectDrawn(page);
  expect(await diagramMarkup(page)).toContain("fill:#1A1A1A");
  await captureScreenshot(page, testInfo, "markdown-diagram-light");

  // Switching theme with the message open redraws it.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect.poll(() => diagramMarkup(page)).toContain("fill:#ECECEE");
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
  // The page itself does not scroll sideways; only the diagram card does.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "markdown-diagram-wide-phone");
});

test("a diagram's accTitle becomes its alt text", async ({ page }, testInfo) => {
  await page.goto(`${fixture}?case=sequence`);
  const image = await expectDrawn(page);
  await expect(image).toHaveAttribute("alt", "Approval round trip");
  await captureScreenshot(page, testInfo, "markdown-diagram-sequence");
});

test("source Mermaid cannot parse stays a readable code block", async ({ page }, testInfo) => {
  await page.goto(`${fixture}?case=invalid`);
  const message = page.getByTestId("diagram-fixture");
  const blocks = message.locator("pre");
  await expect(blocks).toHaveCount(2);
  await expect(blocks.first()).toContainText("A[Unclosed --> B");
  await expect(blocks.nth(1)).toContainText("const ok = true;");
  // Give a late render the chance to replace the block before asserting it never does.
  await page.waitForTimeout(500);
  await expect(page.getByTestId("chat-diagram")).toHaveCount(0);
  await expect(message.getByRole("button", { name: "Copy code" })).toHaveCount(2);
  // Mermaid's error graphic must not appear anywhere on the page.
  await expect(page.locator("body > [id^='drk-mermaid'], body > svg")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "markdown-diagram-invalid");
});

test("a fence still streaming reads as code until it closes", async ({ page }) => {
  await page.goto(`${fixture}?case=plain&stream=1`);
  const message = page.getByTestId("diagram-fixture");

  await streamUpdate(page, "Drafting:\n\n```mermaid\ngraph LR\n  A[Clone repo] -->", true);
  await expect(message.locator("pre")).toContainText("A[Clone repo] -->");
  await page.waitForTimeout(500);
  await expect(page.getByTestId("chat-diagram")).toHaveCount(0);

  // Closed while the rest of the message is still arriving: drawn now.
  await streamUpdate(page, `Drafting:\n\n\`\`\`mermaid\n${flowSource}\n\`\`\`\n\nAnd then`, true);
  await expectDrawn(page);
  await expect(message).toContainText("And then");

  await streamUpdate(
    page,
    `Drafting:\n\n\`\`\`mermaid\n${flowSource}\n\`\`\`\n\nAnd then done.`,
    false,
  );
  await expectDrawn(page);
});

test("a quoted streaming diagram waits for its closing fence", async ({ page }, testInfo) => {
  await page.goto(`${fixture}?case=plain&stream=1`);
  const open = `> \`\`\`mermaid\n${flowSource
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}`;
  await streamUpdate(page, open, true);
  await expect(page.getByTestId("diagram-fixture").locator("blockquote pre")).toContainText(
    flowSource,
  );
  await page.waitForTimeout(500);
  await expect(page.getByTestId("chat-diagram")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "markdown-diagram-quoted-streaming");

  await streamUpdate(page, `${open}\n> \`\`\``, true);
  await expectDrawn(page);
});

test("the copy button copies the diagram source", async ({ page }) => {
  await page.goto(fixture);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await expectDrawn(page);
  const copy = page.getByRole("button", { name: "Copy diagram source" });
  await copy.click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(flowSource);
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
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
  await page.waitForTimeout(500);
  expect(libraryRequests).toEqual([]);

  await streamUpdate(page, `\`\`\`mermaid\n${flowSource}\n\`\`\``, false);
  await expectDrawn(page);
  expect(libraryRequests.length).toBeGreaterThan(0);
});
