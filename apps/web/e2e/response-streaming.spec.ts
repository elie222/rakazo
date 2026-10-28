import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const fixture = "/e2e/fixtures/response-streaming.html";

const LIVE_TOKENS = "Lisbon is the cap";
const COMPLETE_TEXT = "Lisbon is the capital of Portugal.";

async function openFixture(page: Page, query: { stream: "on" | "off"; phase: "live" | "done" }) {
  const params = new URLSearchParams(query);
  await page.goto(`${fixture}?${params}`);
  await expect(page.getByTestId("fixture-note")).toBeVisible();
}

test("thread reducer hides live tokens when Stream replies is off", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  await openFixture(page, { stream: "on", phase: "live" });
  await expect(page.getByTestId("message-user-bubble")).toHaveText(
    "What's the capital of Portugal?",
  );
  await expect(page.getByTestId("message-bot-bubble")).toContainText(LIVE_TOKENS);
  await expect(page.locator(".rk-chat-markdown-streaming")).toHaveCount(1);
  await expect(page.locator(".rk-chat-markdown-cursor")).toHaveCount(1);
  await expect(page.getByTestId("message-bot-bubble")).not.toContainText(COMPLETE_TEXT);
  await expect(page.getByRole("status")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "thread-stream-on-live");

  await openFixture(page, { stream: "off", phase: "live" });
  await expect(page.getByTestId("message-user-bubble")).toBeVisible();
  await expect(page.getByTestId("message-bot-bubble")).toHaveCount(0);
  await expect(page.getByTestId("tool-activity")).toContainText("Browser");
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.locator(".rk-chat-markdown-cursor")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "thread-stream-off-live");

  await openFixture(page, { stream: "off", phase: "done" });
  await expect(page.getByTestId("message-bot-bubble")).toContainText(COMPLETE_TEXT);
  await expect(page.locator(".rk-chat-markdown-streaming")).toHaveCount(0);
  await expect(page.locator(".rk-chat-markdown-cursor")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "thread-stream-off-done");
});
