import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { BillingStatus } from "@rakazo/contracts";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  signup,
} from "../helpers/helpers";

const price = { amount: 1000, currency: "usd", interval: "month", intervalCount: 1 } as const;

function billingStatus(overrides: Partial<BillingStatus>): BillingStatus {
  return {
    access: true,
    canManage: true,
    trialAvailable: false,
    trialDays: 7,
    state: "none",
    price,
    seats: 1,
    trialEndsAt: null,
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    hasCustomer: false,
    creditPurchasesEnabled: true,
    byokPriceCents: 1000,
    funding: "byok",
    balanceUsd: 0,
    monthlyAmountCents: null,
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

async function openBilling(page: Page, name: string, status: BillingStatus) {
  await signup(page, `${name}-${Date.now()}@rakazo.test`, "password12", "Demo Customer");
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: status } }));
  await page.reload();
  return openUserSettings(page, "billing");
}

const ownerHint = "Only the organization owner can change or cancel billing.";
const noPaymentHint = "No payment method on file. Nothing will be charged.";

test("an owner on a trial can cancel it from billing", async ({ page }, testInfo) => {
  const settings = await openBilling(
    page,
    "cancel-trial",
    billingStatus({
      state: "trialing",
      trialEndsAt: "2030-01-15T12:00:00.000Z",
      currentPeriodEndsAt: "2030-01-15T12:00:00.000Z",
      hasCustomer: true,
      computerHoursLeft: 4,
    }),
  );
  let portalOpened = false;
  await page.route("**/rpc/billing/portal", async (route) => {
    portalOpened = true;
    await route.fulfill({ json: { json: { url: "/app" } } });
  });
  const cancel = settings.getByRole("button", { name: "Cancel trial", exact: true });
  await expect(cancel.first()).toBeVisible();
  await expect(settings.getByText(ownerHint, { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "billing-cancel-trial");
  await cancel.first().click();
  await expect.poll(() => portalOpened).toBe(true);
});

test("an owner on an active plan can cancel it from billing", async ({ page }, testInfo) => {
  const settings = await openBilling(
    page,
    "cancel-plan",
    billingStatus({
      state: "active",
      byokInterval: "month",
      currentPeriodEndsAt: "2030-01-15T12:00:00.000Z",
      hasCustomer: true,
    }),
  );
  await expect(
    settings.getByRole("button", { name: "Cancel plan", exact: true }).first(),
  ).toBeVisible();
  await expect(settings.getByRole("button", { name: "Cancel trial" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "billing-cancel-plan");
});

test("a member who is not the owner is told who manages billing", async ({ page }, testInfo) => {
  const settings = await openBilling(
    page,
    "billing-member",
    billingStatus({
      canManage: false,
      state: "active",
      byokInterval: "month",
      currentPeriodEndsAt: "2030-01-15T12:00:00.000Z",
      hasCustomer: true,
    }),
  );
  await expect(settings.getByText(ownerHint, { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Cancel plan" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "billing-member-owner-hint");
});

test("a free own-key period without a card says nothing will be charged", async ({
  page,
}, testInfo) => {
  const settings = await openBilling(
    page,
    "billing-free-no-card",
    billingStatus({ byokFreeUntil: "2030-01-15T12:00:00.000Z", hasCustomer: false }),
  );
  await expect(settings.getByText(noPaymentHint, { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: /^Cancel (trial|plan)$/ })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "billing-free-no-payment-method");
});
