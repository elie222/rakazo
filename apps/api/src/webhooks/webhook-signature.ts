import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookSignature } from "@rakazo/contracts";

/** How far a signed timestamp may be from now, either way, before a delivery is refused. */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

type Algorithm = "sha256" | "sha512" | "sha1";
type Encoding = "hex" | "base64";

type SignedDelivery = {
  /** The exact bytes the sender signed. */
  message: string;
  candidates: string[];
  algorithm: Algorithm;
  encoding: Encoding;
  timestamp?: string;
  /** A delivery id the signature covers. */
  id?: string;
};

/** What a valid signature covers besides the body, for deduplicating deliveries. */
export type SignedParts = { id?: string; timestamp?: string };

const ENCODED = { hex: /^[0-9a-f]+$/i, base64: /^[A-Za-z0-9+/_-]+={0,2}$/ } as const;

/**
 * The HMAC key a scheme uses for a secret, or null when the secret cannot be one. Standard
 * Webhooks secrets are base64 after an optional `whsec_` prefix; every other scheme keys on the
 * secret's text as given.
 */
export function webhookSigningKey(scheme: WebhookSignature["scheme"], secret: string) {
  if (scheme !== "standard-webhooks") return secret ? Buffer.from(secret, "utf8") : null;
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  return Buffer.from(encoded, "base64");
}

function signedDelivery(
  signature: WebhookSignature,
  header: (name: string) => string | undefined,
  body: string,
): SignedDelivery | null {
  switch (signature.scheme) {
    case "standard-webhooks": {
      // Some senders still use the older `svix-` names for the same three headers.
      const id = header("webhook-id") ?? header("svix-id");
      const timestamp = header("webhook-timestamp") ?? header("svix-timestamp");
      const signatures = header("webhook-signature") ?? header("svix-signature");
      if (!id || !timestamp || !signatures) return null;
      return {
        message: `${id}.${timestamp}.${body}`,
        // Space-separated, one per active key while the sender rotates its secret.
        candidates: signatures
          .split(" ")
          .filter((entry) => entry.startsWith("v1,"))
          .map((entry) => entry.slice("v1,".length)),
        algorithm: "sha256",
        encoding: "base64",
        timestamp,
        id,
      };
    }
    case "hmac": {
      const value = header(signature.header)?.trim();
      if (!value?.startsWith(signature.prefix)) return null;
      return {
        message: body,
        candidates: [value.slice(signature.prefix.length)],
        algorithm: signature.algorithm,
        encoding: signature.encoding,
      };
    }
    case "timestamp-v1": {
      const pairs = (header(signature.header) ?? "").split(",").map((pair) => pair.trim());
      const timestamps = pairs.filter((pair) => pair.startsWith("t="));
      if (timestamps.length !== 1) return null;
      const timestamp = timestamps[0]!.slice("t=".length);
      return {
        message: `${timestamp}.${body}`,
        candidates: pairs
          .filter((pair) => pair.startsWith("v1="))
          .map((pair) => pair.slice("v1=".length)),
        algorithm: "sha256",
        encoding: "hex",
        timestamp,
      };
    }
    case "timestamp-v0": {
      const value = header(signature.header)?.trim();
      const timestamp = header(signature.timestampHeader)?.trim();
      if (!value?.startsWith("v0=") || !timestamp) return null;
      return {
        message: `v0:${timestamp}:${body}`,
        candidates: [value.slice("v0=".length)],
        algorithm: "sha256",
        encoding: "hex",
        timestamp,
      };
    }
  }
}

function freshTimestamp(timestamp: string, nowSeconds: number): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  return Math.abs(nowSeconds - Number(timestamp)) <= WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
}

/**
 * Checks a delivery against the bot's signing scheme and secret. Returns the parts the signature
 * covers besides the body, or null for any missing, malformed, stale or wrong signature.
 */
export function verifyWebhookSignature(
  signature: WebhookSignature,
  secret: string,
  header: (name: string) => string | undefined,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): SignedParts | null {
  const key = webhookSigningKey(signature.scheme, secret);
  const signed = signedDelivery(signature, header, body);
  if (!key || !signed) return null;
  if (signed.timestamp !== undefined && !freshTimestamp(signed.timestamp, nowSeconds)) return null;

  const expected = createHmac(signed.algorithm, key).update(signed.message).digest();
  const matched = signed.candidates.some((candidate) => {
    if (!ENCODED[signed.encoding].test(candidate)) return false;
    const supplied = Buffer.from(candidate, signed.encoding);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (!matched) return null;
  return {
    ...(signed.id === undefined ? {} : { id: signed.id }),
    ...(signed.timestamp === undefined ? {} : { timestamp: signed.timestamp }),
  };
}
