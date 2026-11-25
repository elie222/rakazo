import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "../helpers/helpers";

test("an account owner redeems a credit code from a link", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `redeem-${stamp}@rakazo.test`, "password12", `Redeem ${stamp}`);
  const redeemed: unknown[] = [];
  await page.route("**/rpc/billing/redeemCreditCode", async (route) => {
    redeemed.push(route.request().postDataJSON().json);
    await route.fulfill({ json: { json: { creditCents: 1000 } } });
  });

  await page.goto("/redeem/GIFT-7QK2M9XA");
  await expect(page.getByLabel("Code")).toHaveValue("GIFT-7QK2M9XA");
  await captureScreenshot(page, testInfo, "redeem-credit-code");
  await page.getByRole("button", { name: "Redeem" }).click();
  await expect(page.getByRole("heading", { name: "$10 in credits added" })).toBeVisible();
  expect(redeemed).toEqual([{ code: "GIFT-7QK2M9XA" }]);
});
