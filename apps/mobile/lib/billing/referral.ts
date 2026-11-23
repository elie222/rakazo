import type { BillingStatus } from "@rakazo/contracts";
import { useSyncExternalStore } from "react";

export type Referral = NonNullable<BillingStatus["referral"]>;

// Spaces can belong to different organizations, each with its own invite link, so links are
// kept per Space and the selected Space's is the one shown.
const links = new Map<string, Referral | null>();
let readSelectedSpace: () => string | null = () => null;
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

/** Where the selected Space is read from; the API client owns that selection. */
export function followSelectedSpace(read: () => string | null) {
  readSelectedSpace = read;
}

/**
 * A Space's invite link, from a billing status fetched for it. Null when the deployment does not
 * bill, referrals are off, or the account cannot invite; the gift is hidden then.
 */
export function rememberReferral(spaceId: string | null, next: Referral | null | undefined) {
  if (!spaceId) return;
  links.set(spaceId, next ?? null);
  publish();
}

/** Called when the selected Space changes, including a selection rolled back after a failure. */
export function selectedSpaceChanged() {
  publish();
}

/** Forgets every link, when the account changes or the deployment stops billing. */
export function forgetReferrals() {
  links.clear();
  publish();
}

export function currentReferral(): Referral | null {
  const space = readSelectedSpace();
  return (space && links.get(space)) || null;
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
