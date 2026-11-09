import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("a bot gets its email address from its settings and lists it in the Vault", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-email-${stamp}@rakazo.test`, "password12345678", "Bot Email");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await openBotPanelTab(page, "Computer");
  const header = page.getByTestId("bot-profile-header");

  await header.getByRole("button", { name: "Get an email address" }).click();
  await header.getByRole("textbox", { name: "Email address" }).fill(`scout-${stamp}`);
  await header.getByRole("button", { name: "Claim" }).click();
  const address = `scout-${stamp}@bots.rakazo.test`;
  await expect(header.getByText(address)).toBeVisible();
  await expect(header.getByRole("button", { name: `Copy ${address}` })).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-email-address");
  expect(await rpc(page, "bots/emailAddress", { botId })).toEqual({
    domain: "bots.rakazo.test",
    address,
  });

  const settings = await openUserSettings(page, "vault");
  const listed = settings.getByTestId("vault-bot-emails");
  await expect(listed).toContainText(address);
  await captureScreenshot(page, testInfo, "vault-bot-email");
});
