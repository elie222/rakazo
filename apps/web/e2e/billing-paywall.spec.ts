import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

const price = { amount: 1200, currency: "usd", interval: "month", intervalCount: 1 };

function billingStatus(overrides: Record<string, unknown>) {
  return {
    access: false,
    canManage: true,
    trialAvailable: true,
    trialDays: 7,
    state: "none",
    price,
    seats: 1,
    trialEndsAt: null,
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    hasCustomer: false,
    ...overrides,
  };
}

async function enableBilling(route: Route, path: "me" | "bootstrap") {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = path === "me" ? body.json : (body.json?.me as Record<string, unknown> | undefined);
  if (me) me.billingEnabled = true;
  await route.fulfill({ response, json: body });
}

test("billing paywall holds the app until the subscription is active", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `billing-${stamp}@rakazo.test`, "password12", `Billing ${stamp}`);
  await completeOnboarding(page);

  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  let status = billingStatus({});
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: status } }));
  await page.reload();

  const paywall = page.getByTestId("billing-paywall");
  await expect(paywall.getByRole("button", { name: "Start 7-day free trial" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "$12 / month" })).toBeVisible();
  await expect(paywall.getByRole("button", { name: "Log out" })).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-paywall");

  // An unpaid subscription resumes in the portal rather than starting a second checkout.
  status = billingStatus({ trialAvailable: false, state: "unpaid", hasCustomer: true });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(paywall.getByRole("button", { name: "Manage billing" })).toBeVisible();
  await expect(paywall.getByRole("button", { name: "Subscribe" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "billing-paywall-unpaid");

  status = billingStatus({
    access: true,
    trialAvailable: false,
    state: "active",
    seats: 3,
    currentPeriodEndsAt: "2030-01-15T12:00:00.000Z",
    hasCustomer: true,
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Chief").first()).toBeVisible();

  const settings = await openUserSettings(page, "billing");
  await expect(settings).toHaveAttribute("data-settings-section", "billing");
  const billing = settings.getByTestId("billing-settings");
  await expect(billing.getByRole("heading", { name: "Active", exact: true })).toBeVisible();
  await expect(billing.getByText("$12 / month · 3 seats")).toBeVisible();
  await expect(billing.getByText(/^Renews /)).toBeVisible();
  await expect(billing.getByRole("button", { name: "Manage" })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-billing");
});

test("choose free API keys or monthly credits, then add a one-time top-up", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `credit-choice-${stamp}@rakazo.test`, "password12", "Demo Customer");
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  let status = billingStatus({
    creditPurchasesEnabled: true,
    funding: null,
    balanceUsd: 0,
    monthlyAmountCents: null,
    trialAvailable: false,
    trialDays: 0,
  });
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: status } }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose how to use Rakazo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect my own", exact: true })).toBeVisible();
  await expect(page.getByText("Hosted computer included.", { exact: true })).toHaveCount(0);
  const planSelect = page.getByRole("combobox", { name: "Monthly credits" });
  await expect(planSelect).toHaveCSS("height", "48px");
  await expect(planSelect).toContainText("$20 / month");
  await planSelect.click();
  const options = page.locator('[data-slot="select-content"]');
  await expect
    .poll(async () => {
      const [trigger, menu] = await Promise.all([planSelect.boundingBox(), options.boundingBox()]);
      return trigger && menu ? Math.abs(trigger.width - menu.width) : 999;
    })
    .toBeLessThanOrEqual(2);
  const triggerBox = await planSelect.boundingBox();
  const optionsBox = await options.boundingBox();
  expect(optionsBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height);
  await captureScreenshot(page, testInfo, "billing-credit-options");
  await page.keyboard.press("Escape");
  await expect(
    page.getByText("$20 in monthly model credits. No API key needed.", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-credit-choice");
  let purchase: { amountCents: number; monthly: boolean } | undefined;
  await page.route("**/rpc/billing/purchaseCredits", async (route) => {
    purchase = route.request().postDataJSON().json;
    status = billingStatus({
      access: true,
      creditPurchasesEnabled: true,
      funding: "credits",
      balanceUsd: 20,
      monthlyAmountCents: 2000,
      state: "active",
      hasCustomer: true,
      price: { ...price, amount: 2000 },
    });
    await route.fulfill({ json: { json: { url: new URL("/app", page.url()).href } } });
  });
  await page.getByRole("button", { name: "Continue with credits" }).click();
  await expect(page.getByText("Chief").first()).toBeVisible();
  expect(purchase).toEqual({ amountCents: 2000, monthly: true });
  const settings = await openUserSettings(page, "billing");
  await expect(settings.getByText("$20.00", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-credit-balance");
  await settings.getByRole("button", { name: "Add credits", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add credits" });
  await expect(dialog.getByRole("combobox", { name: "Credit amount" })).toHaveCSS("height", "48px");
  await dialog.getByRole("combobox", { name: "Credit amount" }).click();
  await page.getByRole("option", { name: "$50", exact: true }).click();
  await captureScreenshot(page, testInfo, "billing-add-credits");
  await Promise.all([
    page.waitForEvent("load"),
    dialog.getByRole("button", { name: "Continue to checkout" }).click(),
  ]);
  await expect(page.getByText("Chief").first()).toBeVisible();
  expect(purchase).toEqual({ amountCents: 5000, monthly: false });

  status = billingStatus({
    creditPurchasesEnabled: true,
    funding: null,
    balanceUsd: 0,
    monthlyAmountCents: null,
  });
  await page.reload();
  await page.route("**/rpc/billing/selectFunding", async (route) => {
    status = billingStatus({
      access: true,
      creditPurchasesEnabled: true,
      funding: "byok",
      balanceUsd: 0,
      monthlyAmountCents: null,
    });
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await page.getByRole("button", { name: "Connect my own", exact: true }).click();
  await expect(page.getByText("Chief").first()).toBeVisible();
  status = billingStatus({
    access: true,
    creditPurchasesEnabled: true,
    funding: "byok",
    balanceUsd: 12,
    monthlyAmountCents: null,
  });
  await page.reload();
  const existingCredits = await openUserSettings(page, "billing");
  await page.route("**/rpc/billing/selectFunding", async (route) => {
    expect(route.request().postDataJSON().json).toEqual({ funding: "credits" });
    status = { ...status, funding: "credits" };
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await captureScreenshot(page, testInfo, "billing-use-existing-credits");
  // Switching reloads the page; the URL keeps Billing open to show the result.
  await existingCredits.getByRole("button", { name: "Use Rakazo credits", exact: true }).click();
  const reactivated = page.getByTestId("user-settings");
  await expect(reactivated).toHaveAttribute("data-settings-section", "billing");
  await expect(reactivated.getByText("$12.00", { exact: true })).toBeVisible();
  await expect(
    reactivated.getByRole("button", { name: "Use Rakazo credits", exact: true }),
  ).toHaveCount(0);
  expect(purchase).toEqual({ amountCents: 5000, monthly: false });
});
