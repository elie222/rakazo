import type { BillingStatus } from "@rakazo/contracts";
import { useSyncExternalStore } from "react";

export type Referral = NonNullable<BillingStatus["referral"]>;

let current: Referral | null = null;
const listeners = new Set<() => void>();

/**
 * The signed-in owner's invite link, from the latest billing status. Null when the deployment
 * does not bill, referrals are off, or the account cannot invite; the gift is hidden then.
 */
export function rememberReferral(next: Referral | null | undefined) {
  const value = next ?? null;
  if (value?.url === current?.url && value?.rewards === current?.rewards) return;
  current = value;
  for (const listener of listeners) listener();
}

export function currentReferral(): Referral | null {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useReferral(): Referral | null {
  return useSyncExternalStore(subscribe, currentReferral, currentReferral);
}
