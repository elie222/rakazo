import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("bot-to-bot DM transcript is visible from both bot threads", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-dm-${stamp}@rakazo.test`, "password12", "Bot DM");
  await completeOnboarding(page, ["A bit of everything", "Clear and tight"]);

  const chiefId = activeBotId(page);
  const researcher = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "Researcher",
    description: "Checks launch plans",
    instructions: "",
    notifyOnFinish: false,
  });

  const composer = page.getByPlaceholder("Message Chief");
  await composer.fill("message the bot named Researcher saying Review the launch brief.");
  await page.keyboard.press("Enter");

  const outbound = page.getByRole("button", { name: "Messaged Researcher" });
  await expect(outbound).toBeVisible({ timeout: 30_000 });
  await outbound.click();
  const overlay = page.getByTestId("bot-channel-overlay");
  await expect(overlay.getByText("This chat is view-only")).toBeVisible();
  await expect(overlay.getByText("Review the launch brief.", { exact: true })).toBeVisible();
  await expect(overlay.getByText("Chief", { exact: true }).first()).toBeVisible();
  await expect(overlay.getByText("Researcher", { exact: true }).first()).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-dm-transcript");

  await page.getByRole("button", { name: "Close chat", exact: true }).click();
  await page
    .getByRole("complementary")
    .getByRole("button", { name: /^Researcher/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/app/${researcher.id}$`));
  await expect(page.getByRole("button", { name: "Message from Chief" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByTestId("transcript").getByText("Review the launch brief.", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-dm-recipient-thread");

  const channel = await rpc<{
    left: { id: string };
    right: { id: string };
    messages: Array<{ text: string }>;
    hasOlderMessages: boolean;
  }>(page, "threads/channel", { botId: chiefId, peerBotId: researcher.id });
  expect(new Set([channel.left.id, channel.right.id])).toEqual(new Set([chiefId, researcher.id]));
  expect(channel.messages.map((message) => message.text)).toEqual(["Review the launch brief."]);
  expect(channel.hasOlderMessages).toBe(false);
});
