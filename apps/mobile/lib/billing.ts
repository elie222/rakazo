import type { BillingStatus } from "@rakazo/contracts";
import { MOBILE_BILLING_CALLBACK_URL } from "@rakazo/contracts";
import { Linking } from "react-native";
import { rpc } from "./api";

export type Plan = "byok" | "credits";

/** What the own-key plan's button does: a first trial, a paid checkout, or no payment at all. */
export function ownKeyOffer(status: BillingStatus): "trial" | "subscribe" | "free" {
  if (!status.byokPriceCents) return "free";
  return status.trialAvailable && !status.byokFreeUntil ? "trial" : "subscribe";
}

/** A plan that runs out on its own: a trial, a free period, or a canceled renewal. */
export function planEndsAt(status: BillingStatus): string | null {
  if (status.byokFreeUntil) return status.byokFreeUntil;
  if (status.state === "trialing") return status.trialEndsAt ?? null;
  return status.cancelAtPeriodEnd ? (status.currentPeriodEndsAt ?? null) : null;
}

/** The plan the organization pays with, once it has access. */
export function currentPlan(status: BillingStatus): Plan | null {
  if (!status.access) return null;
  return status.funding === "byok" ? "byok" : status.funding === "credits" ? "credits" : null;
}

/**
 * Whether a checkout changed the plan. A canceled checkout returns to the same status, and
 * an organization that already had access (a free period, or changing plans) still has it.
 */
export function purchaseCompleted(before: BillingStatus, after: BillingStatus): boolean {
  if (!after.access) return false;
  return (
    !before.access ||
    after.state !== before.state ||
    after.funding !== before.funding ||
    after.monthlyAmountCents !== before.monthlyAmountCents ||
    after.byokFreeUntil !== before.byokFreeUntil
  );
}

let paywallShown = false;

/** The paywall holds the app until a plan is chosen; the inbox must not stack a second one. */
export function setPaywallShown(shown: boolean) {
  paywallShown = shown;
}

export function isPaywallShown() {
  return paywallShown;
}

/**
 * Opens a hosted checkout or billing portal in the in-app browser, which closes when the
 * provider returns to the app, then reads the result straight from the provider so the
 * app does not wait on the webhook.
 */
export async function openBillingPage(url: string): Promise<BillingStatus> {
  // Defer the native module so billing still opens (in Safari) on older binaries.
  const browser = await import("expo-web-browser").catch(() => null);
  // Ephemeral, so iOS opens checkout without asking to "sign in" with the payment site first.
  if (browser)
    await browser.openAuthSessionAsync(url, MOBILE_BILLING_CALLBACK_URL, {
      preferEphemeralSession: true,
    });
  else await Linking.openURL(url);
  return rpc("billing/refresh");
}
