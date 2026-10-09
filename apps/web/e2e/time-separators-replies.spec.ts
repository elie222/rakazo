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
  await quote.click();
  await expect(parent).toBeInViewport();
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "time-separator-sent-reply");
});

test("replying to a photo shows authenticated thumbnails before and after sending", async ({
  page,
}, testInfo) => {
  await signup(page, `photo-replies-${Date.now()}@rakazo.test`, "password12", "Reply Tester");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "threads/clear", { botId });
  const artifact = await rpc<{ id: string }>(page, "artifacts/create", {
    botId,
    name: "photo.png",
    mimeType: "image/png",
    contentBase64:
      "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAAAAADAXy3SAAAAoklEQVR4nO3N2Q2DQBAE0Q52onNMDgZZCGHYnQOY/kDqCqAevuQgQIAAAQIECCgBH3IC3geYGROwNRZgewzAjnUDNtYJTPZVogI4+xqRA8G+QmRAss+JGCjsMyICivuY8IEL+4jwgIt7n5gDN/YeMQNu7ufECDzYz4gz8HA/Eujenwn0748EGPt/Apz9ToC13wjw9isB5v4XyH8BAgQIENDSAqgRnIOxLnpHAAAAAElFTkSuQmCC",
  });
  await rpc(page, "threads/send", {
    botId,
    text: "",
    artifactIds: [artifact.id],
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const parent = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ has: page.getByRole("img", { name: "photo.png", exact: true }) })
    .first();
  await expect(parent).toBeVisible();
  await parent.hover();
  await parent.getByRole("button", { name: "Reply", exact: true }).click();
  const chip = page.getByTestId("reply-chip");
  await expect(chip).toContainText("You: Photo");
  await expect(chip.locator("img")).toBeVisible();
  await captureScreenshot(page, testInfo, "photo-reply-composer");
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("Review this photo.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const reply = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ hasText: "Review this photo." })
    .filter({ has: page.getByTestId("message-user-bubble") })
    .first();
  const quote = reply.getByTestId("reply-parent-preview");
  await expect(quote).toContainText("You: Photo");
  await expect(quote.locator("img")).toBeVisible();
  await captureScreenshot(page, testInfo, "photo-reply-sent");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(quote).toContainText("You: Photo");
  await expect(quote.locator("img")).toBeVisible();
  await quote.click();
  await expect(parent).toBeInViewport();
});
