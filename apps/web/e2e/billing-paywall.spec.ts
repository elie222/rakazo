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
