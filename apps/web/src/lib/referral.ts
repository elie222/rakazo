import type { BillingStatus } from "@rakazo/contracts";
import { rpc } from "./rpc";

const STORAGE_KEY = "rakazo:referral";

/** Keeps an invite code from the landing URL until the account exists to claim it. */
export function captureReferral(search: string): void {
  const code = new URLSearchParams(search).get("ref")?.trim();
  if (!code) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Storage can be unavailable; the invite just goes unattributed.
  }
}

/**
 * Billing status, with any stored invite code sent along: the server claims it first, so an
 * invited friend's first status already offers the longer trial. The code is kept until a
 * request carrying it succeeds.
 */
export async function loadBillingStatus(): Promise<BillingStatus> {
  let code: string | null = null;
  try {
    code = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable; billing still loads.
  }
  const status = await rpc.billing.status(code ? { referralCode: code } : undefined);
  if (code) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
  return status;
}
