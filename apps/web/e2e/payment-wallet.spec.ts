import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("wallet settings connect with a code and disconnect after confirming", async ({
  page,
}, testInfo) => {
  // The emulator's sign-in page does not exist; record where the app sends the user instead.
  await page.addInitScript(() => {
    const opened: string[] = [];
    Object.assign(window, { __walletPages: opened });
    window.open = (url?: string | URL) => {
      opened.push(String(url));
      return null;
    };
  });
  const stamp = Date.now();
  await signup(page, `wallet-${stamp}@rakazo.test`, "password12", `Wallet ${stamp}`);
  await completeOnboarding(page);

  // The emulator finishes sign-in on the first status read; hold it open to show the code.
  let connecting: unknown;
  let hold = true;
  await page.route("**/rpc/paymentWallet/connect", async (route) => {
    const response = await route.fetch();
    connecting = await response.json();
    await route.fulfill({ response, json: connecting });
  });
  await page.route("**/rpc/paymentWallet/status", async (route) => {
    if (hold && connecting) await route.fulfill({ json: connecting });
    else await route.fallback();
  });

  const settings = await openUserSettings(page, "wallet");
  const wallet = settings.getByTestId("payment-wallet-settings");
  await expect(wallet.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "payment-wallet-disconnected");

  await wallet.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(wallet.getByTestId("payment-wallet-code")).toHaveText("EMUL-ATOR");
  await expect(wallet.getByRole("button", { name: "Open", exact: true })).toBeVisible();
  await expect(wallet.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __walletPages: string[] }).__walletPages),
  ).toEqual([expect.stringContaining("wallet.emulator.invalid")]);
  await captureScreenshot(page, testInfo, "payment-wallet-connecting");

  hold = false;
  await expect(wallet.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await expect(wallet.getByTestId("payment-wallet-code")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "payment-wallet-connected");

  await wallet.getByRole("button", { name: "Disconnect", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await captureScreenshot(page, testInfo, "payment-wallet-disconnect-confirm");
  await confirm.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(wallet.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
});
