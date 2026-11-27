import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { hasValidBearerToken } from "@rakazo/core/node/secrets-guard";
import type { Hono } from "hono";
import { readBoundedBytes } from "../http/http-body.js";
import { formatWebhookPrompt } from "../messaging/inbound-delivery.prompt.js";
import { mountGithubWebhookRoute } from "./github-webhook.js";
import type { WebhookDeps, WebhookSecretCache } from "./webhook-inbound.js";
import {
  deliverWebhookEvent,
  loadWebhookTarget,
  parseWebhookPayload,
  WEBHOOK_MAX_BODY_BYTES,
  webhookDeliveryResponse,
} from "./webhook-inbound.js";
import { hasValidWebhookSignature } from "./webhook-signature.js";

export {
  formatUntrustedDeliveryPayload,
  formatWebhookPrompt,
} from "../messaging/inbound-delivery.prompt.js";
export {
  formatGithubEventPrompt,
  githubEventName,
  hasValidGithubSignature,
} from "./github-webhook.js";
export {
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_SECRET_KIND,
  type WebhookDeps,
  type WebhookEvents,
  type WebhookTarget,
} from "./webhook-inbound.js";

export function mountWebhookHttpRoutes(app: Hono, deps: WebhookDeps) {
  const secretCache: WebhookSecretCache = new Map();

  app.post("/api/v1/bots/:botId/webhook", async (c) => {
    const unauthorized = () => c.json({ error: "Unauthorized" }, 401);

    // Reject oversized bodies before target lookup so size limits do not reveal active bots.
    const bytes = await readBoundedBytes(c.req.raw, WEBHOOK_MAX_BODY_BYTES, undefined, {
      preallocateFromContentLength: false,
    });
    if (bytes === null) {
      return c.json({ error: "Payload too large" }, 413);
    }

    let target: Awaited<ReturnType<typeof loadWebhookTarget>>;
    try {
      target = await loadWebhookTarget(deps, secretCache, c.req.param("botId"));
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        return c.json({ error: "Service unavailable" }, 503);
      }
      throw error;
    }

    // Same 401 for missing bot, missing secret, and a bad key or signature so bot ids are not enumerable.
    if (!target) return unauthorized();
    // A sender that cannot set a header signs the delivery with the key instead of sending it.
    const signed =
      c.req.header("webhook-signature") !== undefined
        ? {
            id: c.req.header("webhook-id"),
            timestamp: c.req.header("webhook-timestamp"),
            signature: c.req.header("webhook-signature"),
          }
        : {
            id: c.req.header("svix-id"),
            timestamp: c.req.header("svix-timestamp"),
            signature: c.req.header("svix-signature"),
          };
    const hasKey = hasValidBearerToken(c.req.header("authorization"), target.expected);
    if (!hasKey && !hasValidWebhookSignature(signed, target.expected, bytes)) {
      return unauthorized();
    }
    const raw = new TextDecoder().decode(bytes);

    const webhookRoutines = await deps.prisma.routine.findMany({
      where: {
        botId: target.bot.id,
        spaceId: target.bot.spaceId,
        // The delivery runs as the bot's creator, so only their own routines may ride on it.
        userId: target.bot.userId,
        active: true,
        webhookEnabled: true,
      },
      select: {
        id: true,
        name: true,
        prompt: true,
        modelProvider: true,
        modelId: true,
        thinkingLevel: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });
    if (webhookRoutines.length === 0) {
      return c.json({ ok: true, ignored: true });
    }

    const payload = parseWebhookPayload(raw, c.req.header("content-type"));
    const eventPrompt = formatWebhookPrompt(payload);

    // A payload id often names the resource, not the delivery, so only byte-identical retries collapse.
    // A signed delivery is deduplicated on the id its signature covers, never on a header a replay could change.
    const idempotencyKey =
      (hasKey ? undefined : signed.id) ||
      c.req.header("idempotency-key")?.trim() ||
      c.req.header("x-idempotency-key")?.trim() ||
      c.req.header("webhook-id")?.trim() ||
      c.req.header("svix-id")?.trim() ||
      (typeof payload.id === "string" || typeof payload.event_id === "string" ? raw : "") ||
      undefined;

    return webhookDeliveryResponse(
      c,
      deliverWebhookEvent(deps, target, {
        prompt: eventPrompt,
        routines: webhookRoutines,
        source: "webhook",
        idempotencyKey,
      }),
    );
  });

  mountGithubWebhookRoute(app, deps, secretCache);
}
