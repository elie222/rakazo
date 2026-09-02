import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { EncryptedSecretStore } from "@rakazo/adapters";
import {
  dispatchRoutineEvents,
  eventsFromWebhookPayload,
  webhookDeliveryIdempotency,
} from "@rakazo/adapters";
import type { NormalizedRoutineEvent } from "@rakazo/core";
import { hasValidBearerToken } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";

export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const WEBHOOK_SECRET_KIND = "webhook";

export type WebhookEvents = {
  sendUserMessage(input: {
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    blocks: Array<{ kind: "text"; text: string }>;
    prompt: string;
    trigger: "webhook";
    clientNonce?: string;
  }): Promise<{ messageId: string; runId: string | null; seq: number }>;
};

export type WebhookDeps = {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  events: WebhookEvents;
  jobs: JobPublisher;
  wakeRoutineFromEvent(
    routineId: string,
    event: NormalizedRoutineEvent,
    options?: {
      idempotencyKey?: string;
      alternateIdempotencyKeys?: string[];
      idempotencyScope?: "strict" | "inflight";
    },
  ): Promise<{ runId: string; threadId: string } | null>;
};

export function formatWebhookPrompt(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string" && payload.text.trim()) {
    return payload.text.trim();
  }
  const eventName = typeof payload.event === "string" ? payload.event : "webhook";
  return `[Inbound Event: ${eventName}]\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

export function webhookPath(botId: string): string {
  return `/api/v1/bots/${botId}/webhook`;
}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      return null;
    }
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseWebhookPayload(
  raw: string,
  contentType: string | undefined,
): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const looksJson =
    contentType?.includes("application/json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (looksJson) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { data: parsed };
    } catch {
      return { text: trimmed };
    }
  }
  return { text: trimmed };
}

export function mountWebhookHttpRoutes(app: Hono, deps: WebhookDeps) {
  app.post("/api/v1/bots/:botId/webhook", async (c) => {
    const unauthorized = () => c.json({ error: "Unauthorized" }, 401);
    const botId = c.req.param("botId");
    const authorization = c.req.header("authorization");

    const bot = await deps.prisma.bot.findUnique({
      where: { id: botId, archivedAt: null },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        webhookSecretId: true,
        thread: { select: { id: true } },
      },
    });

    // Same 401 for missing bot, missing secret, and bad bearer so bot ids are not enumerable.
    if (!bot?.thread || !bot.webhookSecretId) {
      return unauthorized();
    }

    const secret = await deps.prisma.secret.findUnique({
      where: { id: bot.webhookSecretId },
      select: { id: true, ciphertext: true, kind: true, userId: true, spaceId: true },
    });
    if (!secret || secret.kind !== WEBHOOK_SECRET_KIND) {
      return unauthorized();
    }
    if (secret.userId !== bot.userId || secret.spaceId !== bot.spaceId) {
      return unauthorized();
    }

    let expected: string;
    try {
      expected = deps.secrets.load(secret.ciphertext, secret.id);
    } catch {
      return unauthorized();
    }
    if (!hasValidBearerToken(authorization, expected)) {
      return unauthorized();
    }

    const raw = await readBoundedBody(c.req.raw, WEBHOOK_MAX_BODY_BYTES);
    if (raw === null) {
      return c.json({ error: "Payload too large" }, 413);
    }

    const payload = parseWebhookPayload(raw, c.req.header("content-type"));
    const events = eventsFromWebhookPayload(payload, {
      eventName: c.req.header("x-github-event") ?? c.req.header("x-rakazo-event"),
    });

    const delivery = webhookDeliveryIdempotency({
      botId: bot.id,
      headers: c.req.raw.headers,
      payload,
      rawBody: raw,
    });
    const deliveryKey = delivery.keys[0]!;
    const woken = await dispatchRoutineEvents({
      deps: {
        prisma: deps.prisma,
        wakeRoutineFromEvent: deps.wakeRoutineFromEvent,
      },
      botId: bot.id,
      spaceId: bot.spaceId,
      events,
      idempotencyKey: deliveryKey,
      alternateIdempotencyKeys: delivery.keys.slice(1),
      idempotencyScope: delivery.scope,
    });

    if (woken.length > 0) {
      return c.json({
        ok: true,
        runIds: woken.map((row) => row.runId),
        routineIds: woken.map((row) => row.routineId),
        runId: woken[0]?.runId ?? null,
      });
    }

    // No matching routine trigger: keep the legacy bot-level webhook wake.
    const eventPrompt = formatWebhookPrompt(payload);
    const clientNonce = deliveryKey;

    const sent = await deps.events.sendUserMessage({
      spaceId: bot.spaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      userId: bot.userId,
      blocks: [{ kind: "text", text: eventPrompt }],
      prompt: eventPrompt,
      trigger: "webhook",
      clientNonce,
    });

    if (sent.runId) {
      await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
        console.error("webhook run enqueue error", error);
      });
    }

    return c.json({ ok: true, messageId: sent.messageId, runId: sent.runId, seq: sent.seq });
  });
}
