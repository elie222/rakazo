import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function seedTallThread(page: Page, botId: string, stamp: string) {
  for (let i = 0; i < 32; i++) {
    await rpc(page, "threads/send", {
      botId,
      text: `scroll-bot-switch-${stamp}-${i}\nline two\nline three`,
      clientNonce: `sbs-${stamp}-${i}`,
    });
  }
  await rpc(page, "threads/stop", { botId });
}

test("switching bots lands the transcript at the latest messages", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `scroll-bot-switch-${stamp}@rakazo.test`, "password12", "Scroll Switch");
  await completeOnboarding(page);

  const botAId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId: botAId });

  const transcript = page.getByTestId("transcript");
  const gapToEnd = () =>
    transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const assertNearLatest = async () => {
    await expect.poll(gapToEnd, { timeout: 20_000 }).toBeLessThan(80);
  };
  const lastUserRow = (needle: string) =>
    transcript
      .locator("[data-message-id]")
      .filter({ has: page.getByTestId("message-user-bubble") })
      .filter({ hasText: needle })
      .last();
  const rosterBot = (botId: string) => page.locator(`[data-roster-bot-id="${botId}"]`);

  const tailNeedle = `scroll-bot-switch-${stamp}-31`;
  await seedTallThread(page, botAId, stamp);
  await expect(lastUserRow(tailNeedle)).toBeVisible({ timeout: 30_000 });
  await assertNearLatest();
  await captureScreenshot(page, testInfo, "after-bot-a-tall-thread");

  const botB = await rpc<{ id: string }>(page, "bots/create", {
    name: "Scroll B",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await rpc(page, "threads/send", {
    botId: botB.id,
    text: `scroll-bot-switch-b-${stamp}`,
    clientNonce: `sbs-b-${stamp}`,
  });
  await rpc(page, "threads/stop", { botId: botB.id });

  await expect(rosterBot(botB.id)).toBeVisible({ timeout: 20_000 });
  await rosterBot(botB.id).click();
  await expect(page).toHaveURL(new RegExp(`/app/${botB.id}$`));
  await expect(page.getByRole("combobox", { name: /Message Scroll B/ })).toBeVisible();
  await expect(lastUserRow(`scroll-bot-switch-b-${stamp}`)).toBeVisible({ timeout: 20_000 });
  await assertNearLatest();
  await captureScreenshot(page, testInfo, "after-switch-to-bot-b");

  await rosterBot(botAId).click();
  await expect(page).toHaveURL(new RegExp(`/app/${botAId}$`));
  await expect(page.getByRole("combobox", { name: /Message Chief/ })).toBeVisible();
  await expect(lastUserRow(tailNeedle)).toBeVisible({ timeout: 20_000 });
  await assertNearLatest();
  await captureScreenshot(page, testInfo, "after-return-to-bot-a");
});
