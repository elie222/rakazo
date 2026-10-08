import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a short reply thread shows one time separator and navigates to its parent", async ({
  page,
}, testInfo) => {
  await signup(page, `time-replies-${Date.now()}@rakazo.test`, "password12", "Reply Tester");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "threads/clear", { botId });
  await page.reload({ waitUntil: "domcontentloaded" });
  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill("Let's review the release notes.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue("");
  const parent = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: "Let's review the release notes." })
    .first();
  await expect(parent).toBeVisible();
  await parent.hover();
  await parent.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await expect(page.getByTestId("reply-chip")).toContainText("Let's review the release notes.");
  await expect(composer).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("reply-chip")).toHaveCount(0);
  await parent.hover();
  await parent.getByRole("button", { name: "Reply", exact: true }).click();
  await captureScreenshot(page, testInfo, "time-separator-reply-composer");
  await composer.fill("Start with the mobile changes.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("reply-chip")).toHaveCount(0);
  const reply = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: "Start with the mobile changes." })
    .first();
  const quote = reply.getByTestId("reply-parent-preview");
  await expect(quote).toHaveText("↩ You: Let's review the release notes.");
  await expect(transcript.getByTestId("time-separator")).toHaveCount(1);
  await expect(transcript.getByTestId("time-separator")).toContainText("Today");
  const bubble = reply.getByTestId("message-user-bubble");
  const parentBubble = parent.getByTestId("message-user-bubble");
  const replyBounds = await bubble.boundingBox();
  const parentBounds = await parentBubble.boundingBox();
  const quoteBounds = await quote.boundingBox();
  expect(replyBounds).not.toBeNull();
  expect(parentBounds).not.toBeNull();
  expect(quoteBounds).not.toBeNull();
  expect(
    Math.abs(replyBounds!.x + replyBounds!.width - parentBounds!.x - parentBounds!.width),
  ).toBeLessThan(1);
  expect(quoteBounds!.width).toBeLessThanOrEqual(replyBounds!.width + 1);
  await quote.click();
  await expect
    .poll(() => parentBubble.evaluate((element) => element.getAnimations().length))
    .toBeGreaterThan(0);
  expect(await parent.evaluate((element) => element.getAnimations().length)).toBe(0);
  expect(await parentBubble.evaluate((element) => getComputedStyle(element).borderRadius)).toBe(
    "20px",
  );
  await expect(parent).toBeInViewport();
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "time-separator-sent-reply");
});
