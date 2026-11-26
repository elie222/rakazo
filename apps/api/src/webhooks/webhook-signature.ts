import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a signed delivery's timestamp may sit from the server clock, either way. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

interface SignedDeliveryHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/**
 * Checks a Standard Webhooks signature: `v1,` + base64 HMAC-SHA256 of `{id}.{timestamp}.{body}`,
 * keyed with the secret's own bytes. The header may list several signatures while a sender
 * rotates keys, so any match passes. A stale or future timestamp fails, which bounds replays to
 * the tolerance window; inside it the delivery id deduplicates them.
 */
export function hasValidWebhookSignature(
  headers: SignedDeliveryHeaders,
  secret: string,
  raw: Uint8Array,
  nowMs: number = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const age = Math.abs(Math.floor(nowMs / 1000) - Number(timestamp));
  if (age > WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${id}.${timestamp}.`).update(raw).digest();
  let valid = false;
  for (const entry of signature.split(" ")) {
    if (!entry.startsWith("v1,")) continue;
    const candidate = Buffer.from(entry.slice(3), "base64");
    // Every listed signature is compared so the answer does not depend on which one matched.
    if (candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected)) {
      valid = true;
    }
  }
  return valid;
}
