import { i18n } from "@lingui/core";
import type { BillingStatus } from "@rakazo/contracts";
import { beforeAll, expect, it } from "vitest";
import {
  billingDateLabel,
  formatBillingAmount,
  formatBillingDate,
  formatBillingPrice,
} from "./billing.js";

beforeAll(() => {
  i18n.activate("en");
});

it("shows whole prices without cents and others with them", () => {
  expect(formatBillingAmount(1200, "usd", "en")).toBe("$12");
  expect(formatBillingAmount(1250, "usd", "en")).toBe("$12.50");
});

it("shows a price with its period", () => {
  const price = { amount: 1200, currency: "usd", interval: "month", intervalCount: 1 } as const;
  expect(formatBillingPrice(price, "en")).toBe("$12 / month");
  expect(formatBillingPrice({ ...price, interval: "week", intervalCount: 2 }, "en")).toBe(
    "$12 / 2 weeks",
  );
});

it("labels the next billing date", () => {
  const at = "2026-12-02T12:00:00Z";
  const status = {
    state: "active",
    trialEndsAt: null,
    currentPeriodEndsAt: at,
    cancelAtPeriodEnd: false,
  } as BillingStatus;
  const day = formatBillingDate(at, "en");
  expect(day).toBe("Dec 2, 2026");
  expect(billingDateLabel(status, "en")).toBe(`Renews ${day}`);
  expect(billingDateLabel({ ...status, cancelAtPeriodEnd: true }, "en")).toBe(`Ends ${day}`);
  expect(billingDateLabel({ ...status, state: "paused" }, "en")).toBeNull();
});
