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

export async function claimStoredReferral(): Promise<void> {
  let code: string | null;
  try {
    code = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!code) return;
  try {
    await rpc.billing.claimReferral({ code });
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Retried on the next launch.
  }
}
