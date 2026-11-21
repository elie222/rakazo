import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanel,
  openUserSettings,
  rpc,
  signup,
} from "../helpers/helpers";

async function openManualCopy(page: Page, copy: Locator, address: string) {
  await copy.click();
  const dialog = page.getByRole("dialog", { name: "Email address", exact: true });
  const field = dialog.getByRole("textbox", { name: "Email address", exact: true });
  await expect(field).toHaveValue(address);
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("readonly", "");
  expect(
    await field.evaluate((input: HTMLTextAreaElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([0, address.length]);
  return dialog;
}

test("a bot gets its email address from its settings and lists it in the Vault", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-email-${stamp}@rakazo.test`, "password12", "Bot Email");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await openBotPanel(page);
  const header = page.getByTestId("bot-profile-header");

  await page.getByTestId("bot-settings").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Get an email address" }).click();
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

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException("Synthetic clipboard rejection", "NotAllowedError");
        },
      },
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  });
  const profileCopy = await openManualCopy(
    page,
    header.getByRole("button", { name: `Copy ${address}` }),
    address,
  );
  await profileCopy.getByRole("button", { name: "Close", exact: true }).click();
  await expect(profileCopy).toBeHidden();

  const settings = await openUserSettings(page, "vault");
  const listed = settings.getByTestId("vault-bot-emails");
  await expect(listed).toContainText(address);
  await captureScreenshot(page, testInfo, "vault-bot-email");
  const copy = listed.getByRole("button", { name: `Copy ${address}` });
  const vaultCopy = await openManualCopy(page, copy, address);
  await captureScreenshot(page, testInfo, "vault-bot-email-copy-fallback");
  await vaultCopy.getByRole("button", { name: "Close", exact: true }).click();
  await expect(vaultCopy).toBeHidden();

  await page.evaluate(() => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
        readText: async () => copied,
      },
    });
  });
  await copy.click();
  await expect(listed.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
  await expect(vaultCopy).toBeHidden();
});

test("a bot email claim stays in its shell's Space when another tab switches Spaces", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-email-space-${stamp}@rakazo.test`, "password12", "Bot Email Space");
  await completeOnboarding(page);

  const home = await rpc<{ id: string }>(page, "spaces/create", { name: "Email Home" });
  const other = await rpc<{ id: string }>(page, "spaces/create", { name: "Email Other" });
  const createBot = async (spaceId: string, name: string) => {
    const response = await page.request.post("/rpc/bots/create", {
      headers: { "x-rakazo-space-id": spaceId },
      data: {
        json: { name, description: "", notifyOnFinish: true, computerMode: "team" },
      },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { json: { id: string } }).json;
  };
  const scout = await createBot(home.id, "Scout");
  const otherBot = await createBot(other.id, "Other");

  await page.evaluate((id) => localStorage.setItem("rakazo:space-id", id), home.id);
  await page.goto(`/app/${scout.id}`);
  await expect(page.getByPlaceholder("Message Scout")).toBeVisible();
  await openBotPanel(page);
  const header = page.getByTestId("bot-profile-header");
  await page.getByTestId("bot-settings").getByRole("button", { name: "More actions" }).click();
  const getAddress = page.getByRole("menuitem", { name: "Get an email address" });
  await expect(getAddress).toBeVisible();

  const otherTab = await page.context().newPage();
  await otherTab.addInitScript((id) => localStorage.setItem("rakazo:space-id", id), other.id);
  await otherTab.goto(`/app/${otherBot.id}`);
  await expect(otherTab.getByPlaceholder("Message Other")).toBeVisible();

  await getAddress.click();
  await header.getByRole("textbox", { name: "Email address" }).fill(`scout-${stamp}`);
  await header.getByRole("button", { name: "Claim" }).click();
  const address = `scout-${stamp}@bots.rakazo.test`;
  await expect(header.getByText(address)).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-email-space-claim");
  const response = await page.request.post("/rpc/bots/emailAddress", {
    headers: { "x-rakazo-space-id": home.id },
    data: { json: { botId: scout.id } },
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ json: { address } });

  await otherTab.close();
});
