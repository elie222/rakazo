import { createHash } from "node:crypto";
import type { NormalizedRoutineEvent } from "@rakazo/core";
import {
  coalesceRoutineEventTriggers,
  matchingEventTriggers,
  normalizeRepoEventPayload,
} from "@rakazo/core";

export type RoutineEventWakeResult = {
  routineId: string;
  runId: string;
  threadId: string;
};

export type RoutineEventDispatchDeps = {
  prisma: {
    routine: {
      findMany(args: {
        where: {
          botId: string;
          spaceId: string;
          active: boolean;
          OR: Array<Record<string, unknown>>;
        };
        select: {
          id: true;
          eventTriggers: true;
          webhookEnabled: true;
        };
        orderBy: { updatedAt: "desc" };
      }): Promise<
        Array<{
          id: string;
          eventTriggers: unknown;
          webhookEnabled: boolean;
        }>
      >;
    };
  };
  wakeRoutineFromEvent(
    routineId: string,
    event: NormalizedRoutineEvent,
    options?: {
      idempotencyKey?: string;
      alternateIdempotencyKeys?: string[];
      /** Accepted for callers; webhook claims are always durable (`strict`). */
      idempotencyScope?: "strict" | "inflight";
    },
  ): Promise<{ runId: string; threadId: string } | null>;
};

/**
 * Find active routines on a bot whose event triggers match, and wake each one.
 * Returns the wake results (empty when nothing matched).
 */
export async function dispatchRoutineEvents(input: {
  deps: RoutineEventDispatchDeps;
  botId: string;
  spaceId: string;
  events: NormalizedRoutineEvent[];
  idempotencyKey?: string;
  /** Extra delivery keys that should resolve to the same wake. */
  alternateIdempotencyKeys?: string[];
  /** Accepted for callers; webhook claims are always durable (`strict`). */
  idempotencyScope?: "strict" | "inflight";
}): Promise<RoutineEventWakeResult[]> {
  const routines = await input.deps.prisma.routine.findMany({
    where: {
      botId: input.botId,
      spaceId: input.spaceId,
      active: true,
      OR: [{ webhookEnabled: true }, { NOT: { eventTriggers: { equals: [] } } }],
    },
    select: {
      id: true,
      eventTriggers: true,
      webhookEnabled: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const results: RoutineEventWakeResult[] = [];
  const woken = new Set<string>();

  for (const routine of routines) {
    const triggers = coalesceRoutineEventTriggers(routine.eventTriggers, routine.webhookEnabled);
    if (triggers.length === 0) continue;

    const matched = input.events.some((event) => matchingEventTriggers(triggers, event).length > 0);
    if (!matched || woken.has(routine.id)) continue;

    const promptEvent = pickPromptEvent(triggers, input.events);
    const idempotencyKey = input.idempotencyKey
      ? routineEventIdempotencyKey(routine.id, input.idempotencyKey)
      : undefined;
    const alternateIdempotencyKeys = input.alternateIdempotencyKeys?.map((key) =>
      routineEventIdempotencyKey(routine.id, key),
    );
    const wake = await input.deps.wakeRoutineFromEvent(routine.id, promptEvent, {
      idempotencyKey,
      alternateIdempotencyKeys,
      idempotencyScope: input.idempotencyScope,
    });
    if (!wake) continue;
    woken.add(routine.id);
    results.push({ routineId: routine.id, runId: wake.runId, threadId: wake.threadId });
  }

  return results;
}

/** Prefer a matching repo event over a generic webhook event for the prompt. */
export function pickPromptEvent(
  triggers: ReturnType<typeof coalesceRoutineEventTriggers>,
  events: NormalizedRoutineEvent[],
): NormalizedRoutineEvent {
  const matching = events.filter((event) => matchingEventTriggers(triggers, event).length > 0);
  const repo = matching.find((event) => event.source === "repo");
  if (repo) return repo;
  return matching[0] ?? events[0]!;
}

export function routineEventIdempotencyKey(routineId: string, eventKey: string): string {
  const digest = createHash("sha256").update(`${routineId}:${eventKey}`).digest("base64url");
  return `routine-event:${digest}`;
}

/** Build the webhook + optional repo events from an inbound HTTP payload. */
export function eventsFromWebhookPayload(
  payload: Record<string, unknown>,
  headers: { eventName?: string | null } = {},
): NormalizedRoutineEvent[] {
  const events: NormalizedRoutineEvent[] = [{ source: "webhook", payload }];
  const repo = normalizeRepoEventPayload(payload, headers);
  if (repo) events.push(repo);
  return events;
}

function webhookDeliveryExplicitId(input: {
  headers: Headers | { get(name: string): string | null };
  payload: Record<string, unknown>;
}): string {
  // Only dedicated delivery headers. Payload `id` / `event_id` are often resource
  // ids reused across distinct changes, so they must not become strict keys.
  return (
    input.headers.get("idempotency-key")?.trim() ||
    input.headers.get("x-idempotency-key")?.trim() ||
    input.headers.get("x-github-delivery")?.trim() ||
    input.headers.get("x-delivery-id")?.trim() ||
    input.headers.get("x-request-id")?.trim() ||
    ""
  );
}

function webhookHashedKey(botId: string, material: string): string {
  return `webhook:${botId}:${createHash("sha256").update(material).digest("base64url")}`;
}

export type WebhookDeliveryIdempotency = {
  keys: string[];
  /**
   * Always strict for webhook deliveries: explicit ids and body-hash fallbacks
   * both claim a durable clientNonce so a retry after a terminal run does not
   * start again. Body-hash keys are stable (no time bucket) so concurrent
   * id-less retries cannot create two claims across a clock boundary.
   */
  scope: "strict" | "inflight";
};

/**
 * Delivery keys for a webhook. Index 0 is the claim key for new wakes.
 * Without an explicit delivery header, the body hash itself is the claim key
 * (stable across time) so provider retries always collide on one nonce.
 */
export function webhookDeliveryIdempotency(input: {
  botId: string;
  headers: Headers | { get(name: string): string | null };
  payload: Record<string, unknown>;
  /** Exact request body when available; used when no explicit delivery id is present. */
  rawBody?: string;
}): WebhookDeliveryIdempotency {
  const explicit = webhookDeliveryExplicitId(input);
  if (explicit) {
    return { keys: [webhookHashedKey(input.botId, explicit)], scope: "strict" };
  }
  const body = input.rawBody?.trim() || JSON.stringify(input.payload);
  return {
    keys: [webhookHashedKey(input.botId, body)],
    scope: "strict",
  };
}

export function webhookDeliveryIdempotencyKeys(input: {
  botId: string;
  headers: Headers | { get(name: string): string | null };
  payload: Record<string, unknown>;
  rawBody?: string;
}): string[] {
  return webhookDeliveryIdempotency(input).keys;
}

export function webhookDeliveryIdempotencyKey(input: {
  botId: string;
  headers: Headers | { get(name: string): string | null };
  payload: Record<string, unknown>;
  rawBody?: string;
}): string {
  return webhookDeliveryIdempotency(input).keys[0]!;
}
