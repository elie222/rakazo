import * as z from "zod";
import { Id } from "../ids.js";

/**
 * How a bot's webhook checks a sender's signature when the sender signs deliveries with a secret
 * it generated itself, instead of sending the bot's own key as a bearer token.
 *
 * - `standard-webhooks`: the Standard Webhooks spec. `webhook-id`, `webhook-timestamp` and
 *   `webhook-signature` headers, each `v1,<base64>` an HMAC-SHA256 of `<id>.<timestamp>.<body>`
 *   keyed by the base64 secret after an optional `whsec_` prefix.
 * - `hmac`: an HMAC of the raw body in one header, with an optional prefix such as `sha256=`.
 * - `timestamp-v1`: one header of `t=<timestamp>,v1=<hex>` pairs, each an HMAC-SHA256 of
 *   `<timestamp>.<body>`.
 * - `timestamp-v0`: `v0=<hex>`, an HMAC-SHA256 of `v0:<timestamp>:<body>`, with the timestamp in
 *   its own header.
 */
export const WEBHOOK_SIGNATURE_SCHEMES = [
  "standard-webhooks",
  "hmac",
  "timestamp-v1",
  "timestamp-v0",
] as const;

const HeaderName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_-]{1,64}$/);

export const WebhookSignatureSchema = z.discriminatedUnion("scheme", [
  z.object({ scheme: z.literal("standard-webhooks") }),
  z.object({
    scheme: z.literal("hmac"),
    header: HeaderName,
    /** SHA-1 only for older senders that offer nothing else. */
    algorithm: z.enum(["sha256", "sha512", "sha1"]),
    encoding: z.enum(["hex", "base64"]),
    prefix: z
      .string()
      .max(32)
      .regex(/^[\x21-\x7e]*$/),
  }),
  z.object({ scheme: z.literal("timestamp-v1"), header: HeaderName }),
  z.object({
    scheme: z.literal("timestamp-v0"),
    header: HeaderName,
    timestampHeader: HeaderName,
  }),
]);
export type WebhookSignature = z.infer<typeof WebhookSignatureSchema>;

export const SetWebhookSignatureInput = z.object({
  botId: Id,
  signature: WebhookSignatureSchema,
  /** The signing secret the sender generated; stored encrypted and never returned. */
  secret: z.string().trim().min(1).max(1024),
});
