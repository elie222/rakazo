import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  rpc,
  signup,
} from "./helpers";

test("a bot's creator turns on filling sign-in codes from their connected email", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mail-codes-${stamp}@rakazo.test`, "password12", "Mail Codes");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await openBotPanelTab(page, "Advanced");
  const settings = page.getByTestId("bot-settings");
  const row = settings.getByText("Fill sign-in codes from my connected email", { exact: true });
  await expect(row).toBeVisible();
  const mailCodes = settings.getByRole("switch", {
    name: "Fill sign-in codes from my connected email",
    exact: true,
  });
  await mailCodes.scrollIntoViewIfNeeded();
  await expect(mailCodes).not.toBeChecked();
  await captureScreenshot(page, testInfo, "bot-settings-connected-mail-codes-off");

  await mailCodes.click();
  await expect(mailCodes).toBeChecked();
  await expect
    .poll(async () => {
      const bots = await rpc<Array<{ id: string; connectedMailCodes?: boolean }>>(
        page,
        "bots/list",
        {},
      );
      return bots.find((bot) => bot.id === botId)?.connectedMailCodes;
    })
    .toBe(true);
  await captureScreenshot(page, testInfo, "bot-settings-connected-mail-codes-on");

  await page.reload();
  await openBotPanelTab(page, "Advanced");
  await expect(mailCodes).toBeChecked();
});
