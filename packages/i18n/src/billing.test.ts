import { i18n } from "@lingui/core";
import type { BillingStatus } from "@rakazo/contracts";
import { beforeAll, expect, it } from "vitest";
import { messages as french } from "../locales/fr/messages.po";
import {
  billingDateLabel,
  formatBillingAmount,
  formatBillingDate,
  formatBillingPrice,
  formatMonthlyPrice,
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

it("finds the existing translations in the shared catalog", () => {
  i18n.load("fr", french);
  i18n.activate("fr");
  try {
    const price = { amount: 1200, currency: "usd", interval: "month", intervalCount: 1 } as const;
    expect(formatBillingPrice(price, "fr")).toMatch(/ \/ mois$/);
    expect(formatMonthlyPrice(1200, "fr")).toMatch(/ \/ mois$/);
    const status = {
      state: "active",
      trialEndsAt: null,
      currentPeriodEndsAt: "2026-12-02T12:00:00Z",
      cancelAtPeriodEnd: false,
    } as BillingStatus;
    expect(billingDateLabel(status, "fr")).toMatch(/^Renouvellement le /);
  } finally {
    i18n.activate("en");
  }
});
