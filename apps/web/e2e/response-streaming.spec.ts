import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";

const fixture = "/e2e/fixtures/response-streaming.html";

const LIVE_TOKENS = "Lisbon is the cap";
const COMPLETE_TEXT = "Lisbon is the capital of Portugal.";

async function openFixture(
  page: Page,
  query: { view: "settings" | "thread"; stream: "on" | "off"; phase?: "live" | "done" },
) {
  const params = new URLSearchParams({ view: query.view, stream: query.stream });
  if (query.phase) params.set("phase", query.phase);
  await page.goto(`${fixture}?${params}`);
  if (query.view === "settings") {
    await expect(page.getByTestId("user-settings")).toBeVisible();
    return;
  }
  await expect(page.getByTestId("fixture-note")).toBeVisible();
}

async function writeShot(testInfo: TestInfo, name: string, sourcePath: string) {
  await testInfo.attach(name, { contentType: "image/png", path: sourcePath });
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { animations?: "disabled" | "allow"; clip?: boolean } = {},
) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  const animations = options.animations ?? "disabled";
  if (options.clip) {
    const noteBox = await page.getByTestId("fixture-note").boundingBox();
    const transBox = await page.getByTestId("transcript").boundingBox();
    if (!noteBox || !transBox) throw new Error(`missing clip targets for ${name}`);
    const y = Math.max(0, noteBox.y - 16);
    await page.screenshot({
      animations,
      caret: "hide",
      path: screenshotPath,
      clip: {
        x: 0,
        y,
        width: Math.round(page.viewportSize()?.width ?? 1440),
        height: Math.ceil(transBox.y + transBox.height + 24 - y),
      },
    });
  } else {
    await page.screenshot({
      animations,
      caret: "hide",
      fullPage: true,
      path: screenshotPath,
    });
  }
  await writeShot(testInfo, name, screenshotPath);
}

test("settings overlay keeps Stream replies inside Advanced", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFixture(page, { view: "settings", stream: "off" });
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByRole("heading", { name: "Replies", exact: true })).toHaveCount(0);
  await expect(settings.getByTestId("response-streaming-toggle")).toBeHidden();
  await settings.getByTestId("advanced-settings").locator("summary").click();
  const streamReplies = settings.getByTestId("response-streaming-toggle");
  await expect(streamReplies).toBeVisible();
  await expect(streamReplies).not.toBeChecked();
  await expect(settings.getByText("Stream replies", { exact: true })).toBeVisible();
  await streamReplies.scrollIntoViewIfNeeded();
  await capture(page, testInfo, "settings-stream-off");

  await openFixture(page, { view: "settings", stream: "on" });
  const settingsOn = page.getByTestId("user-settings");
  await settingsOn.getByTestId("advanced-settings").locator("summary").click();
  const onToggle = settingsOn.getByTestId("response-streaming-toggle");
  await expect(onToggle).toBeVisible();
  await expect(onToggle).toBeChecked();
  await capture(page, testInfo, "settings-stream-on");
});

test("thread reducer hides live tokens when Stream replies is off", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  await openFixture(page, { view: "thread", stream: "on", phase: "live" });
  await expect(page.getByTestId("message-user-bubble")).toHaveText(
    "What's the capital of Portugal?",
  );
  await expect(page.getByTestId("message-bot-bubble")).toContainText(LIVE_TOKENS);
  await expect(page.locator(".rk-chat-markdown-streaming")).toHaveCount(1);
  await expect(page.locator(".rk-chat-markdown-cursor")).toHaveCount(1);
  await expect(page.getByTestId("message-bot-bubble")).not.toContainText(COMPLETE_TEXT);
  await capture(page, testInfo, "thread-stream-on-live", { animations: "allow", clip: true });

  await openFixture(page, { view: "thread", stream: "off", phase: "live" });
  await expect(page.getByTestId("message-user-bubble")).toBeVisible();
  await expect(page.getByTestId("message-bot-bubble")).toHaveCount(0);
  await expect(page.getByTestId("tool-activity")).toContainText("Browser");
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.locator(".rk-chat-markdown-cursor")).toHaveCount(0);
  await capture(page, testInfo, "thread-stream-off-live", { clip: true });

  await openFixture(page, { view: "thread", stream: "off", phase: "done" });
  await expect(page.getByTestId("message-bot-bubble")).toContainText(COMPLETE_TEXT);
  await expect(page.locator(".rk-chat-markdown-streaming")).toHaveCount(0);
  await expect(page.locator(".rk-chat-markdown-cursor")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(0);
  await capture(page, testInfo, "thread-stream-off-done", { clip: true });
});
