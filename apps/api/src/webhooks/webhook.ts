import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { hasValidBearerToken } from "@rakazo/core/node/secrets-guard";
import type { Context, Hono } from "hono";
import { requestClientIp } from "../http/client-ip.js";
import { readBoundedBody } from "../http/http-body.js";
import { throttleKey, windowCounter } from "../http/window-counter.js";
import { formatWebhookPrompt } from "../messaging/inbound-delivery.prompt.js";
import { mountGithubWebhookRoute } from "./github-webhook.js";
import type { WebhookDeps, WebhookSecretCache, WebhookThrottle } from "./webhook-inbound.js";
import {
  deliverWebhookEvent,
  loadWebhookTarget,
  parseWebhookPayload,
  WEBHOOK_MAX_BODY_BYTES,
  webhookDeliveryResponse,
} from "./webhook-inbound.js";

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

const MINUTE_MS = 60_000;
export const WEBHOOKS_PER_IP_PER_MINUTE = 120;

export function mountWebhookHttpRoutes(
  app: Hono,
  deps: WebhookDeps,
  clientIp: (c: Context) => string | undefined = requestClientIp,
) {
  const secretCache: WebhookSecretCache = new Map();
  // Target lookup runs before any signature check, so one address must not drive those database
  // reads at line rate with random bot ids. Only a refused delivery spends the budget: senders
  // share address pools (a CI runner, an automation platform), and on the GitHub route a 429 loses
  // the event for good, so a correctly signed delivery must never be locked out by its neighbours.
  const refusals = windowCounter(MINUTE_MS);
  const address = (c: Context) => throttleKey(clientIp(c));
  const throttle: WebhookThrottle = {
    throttled: (c) => refusals.peek(address(c)) >= WEBHOOKS_PER_IP_PER_MINUTE,
    tooManyRequests: (c) => c.json({ error: "Too many requests" }, 429, { "retry-after": "60" }),
    refuse: (c) => {
      refusals(address(c));
      return c.json({ error: "Unauthorized" }, 401);
    },
  };

  app.post("/api/v1/bots/:botId/webhook", async (c) => {
    if (throttle.throttled(c)) return throttle.tooManyRequests(c);

    // Reject oversized bodies before target lookup so size limits do not reveal active bots.
    const raw = await readBoundedBody(c.req.raw, WEBHOOK_MAX_BODY_BYTES);
    if (raw === null) {
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

    // Same 401 for missing bot, missing secret, and bad bearer so bot ids are not enumerable.
    if (!target || !hasValidBearerToken(c.req.header("authorization"), target.expected)) {
      return throttle.refuse(c);
    }

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
    const idempotencyKey =
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

  mountGithubWebhookRoute(app, deps, secretCache, throttle);
}
