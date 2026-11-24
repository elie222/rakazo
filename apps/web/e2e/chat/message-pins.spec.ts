import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
} from "../helpers/helpers";

test("a chat pin survives reload and opens its original message", async ({ page }, testInfo) => {
  await signup(page, `message-pin-${Date.now()}@rakazo.test`, "password12", "Message Pins");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /^Message/ });
  const text = "Keep this launch checklist within reach";
  await composer.fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const row = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ hasText: text })
    .first();
  const pins = page.getByRole("button", { name: "Pinned messages", exact: true });
  await expect(pins).toBeHidden();
  const more = row.getByRole("button", { name: "More", exact: true });
  await more.focus();
  await more.click();
  await page.getByRole("menuitem", { name: "Pin message", exact: true }).click();
  await expect(pins).toBeVisible();

  const botId = activeBotId(page);
  for (let index = 0; index < 4; index += 1) {
    await rpc(page, "threads/send", {
      botId,
      text: Array.from(
        { length: 20 },
        (_, line) => `Later notes ${index + 1}, line ${line + 1}`,
      ).join("\n"),
      clientNonce: `notes-${index}`,
    });
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(row).not.toBeInViewport();
  await pins.click();
  const pinnedMessage = page.getByRole("menuitem", { name: text, exact: true });
  await expect(pinnedMessage).toBeVisible();
  await captureScreenshot(page, testInfo, "chat-pinned-messages");
  await pinnedMessage.click();
  await expect(row).toBeInViewport();

  await more.focus();
  await more.click();
  await page.getByRole("menuitem", { name: "Unpin message", exact: true }).click();
  await expect(pins).toBeHidden();
});
