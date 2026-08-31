import type {
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingOutboundStatus,
} from "@rakazo/adapter-kit";
import { timingSafeStringEqual } from "@rakazo/core";
import type { Hono } from "hono";
import { readBoundedBody, WEBHOOK_MAX_BODY_BYTES } from "./webhook.js";

export const PHONE_WEBHOOK_PATH = "/api/v1/phone/webhook";

export type PhoneWebhookDeps =
  | {
      /**
       * chat-sdk mode: the transport owns verification (challenge handshake,
       * signature checks) and payload parsing, so the raw request — GET and
       * POST — is delegated unchanged.
       */
      delegate: (request: Request) => Promise<Response>;
    }
  | {
      signingSecret: string;
      /** Vendor auth header name (wired at the composition root). */
      signingHeader: string;
      /** Vendor-specific parse stays at the composition root / adapter boundary. */
      parseInbound: (payload: unknown) => MessagingInboundEvent | null;
      handle: (event: MessagingInboundMessage) => Promise<void>;
      handleStatus?: (event: MessagingOutboundStatus) => Promise<void>;
    };

/**
 * Deployment phone-line inbound webhook. In static-secret mode (SendBlue),
 * verification is a shared secret (no HMAC available from the vendor),
 * compared in constant time; replay safety comes from the `phone:{message_handle}`
 * client nonce downstream. In delegate mode (chat-sdk) the transport owns
 * verification (challenge handshake, signature checks) and parsing. Mounted
 * only when the phone surface is enabled.
 */
export function mountPhoneWebhookRoutes(app: Hono, deps: PhoneWebhookDeps) {
  if ("delegate" in deps) {
    app.all(PHONE_WEBHOOK_PATH, (c) => deps.delegate(c.req.raw));
    return;
  }
  app.post(PHONE_WEBHOOK_PATH, async (c) => {
    // Uniform 401: missing and wrong secrets are indistinguishable.
    if (!timingSafeStringEqual(c.req.header(deps.signingHeader), deps.signingSecret)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const raw = await readBoundedBody(c.req.raw, WEBHOOK_MAX_BODY_BYTES);
    if (raw === null) {
      return c.json({ error: "Payload too large" }, 413);
    }

    let payload: unknown = null;
    try {
      payload = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    const event = deps.parseInbound(payload);
    // Always 200: vendors typically retry on 5xx, and non-message events
    // (call logs, typing indicators) are not actionable here.
    if (event?.type === "message") {
      await deps.handle(event);
    } else if (event?.type === "status") {
      await deps.handleStatus?.(event);
    }
    return c.json({ ok: true });
  });
}
