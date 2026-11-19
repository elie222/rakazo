import type { JobPublisher, SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { InboundSource } from "@rakazo/adapters";
import {
  inboundDeliveryClientNonce,
  inboundRoutineModelPin,
  isPermanentDecryptFailure,
  wakeRun,
} from "@rakazo/adapters";
import type { MessageBlock, WebhookSignature } from "@rakazo/contracts";
import { inboundRoutineBlock } from "@rakazo/core";
import type { PrismaClient, SendUserMessageInput } from "@rakazo/db";
import { accountDeactivated, botWebhookSignature, SpaceDeletionInProgressError } from "@rakazo/db";
import type { Context } from "hono";

export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const WEBHOOK_SECRET_KIND = "webhook";
export const WEBHOOK_SIGNING_SECRET_KIND = "webhook_signing";

export type WebhookEvents = {
  sendUserMessage(input: {
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    blocks: MessageBlock[];
    prompt: string;
    trigger: "webhook";
    clientNonce?: string;
    allowParallelRun?: boolean;
    modelPin?: {
      modelProvider: string;
      modelId: string;
      thinkingLevel: string | null;
    };
  }): Promise<{ messageId: string; runId: string | null; seq: number }>;
};

export type WebhookDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  events: WebhookEvents;
  jobs: Pick<JobPublisher, "enqueue">;
};

export type WebhookTarget = {
  bot: {
    id: string;
    spaceId: string;
    userId: string;
  };
  threadId: string;
  /** The bot's own key: a bearer token on the webhook, the HMAC secret on the GitHub route. */
  expected: string | null;
  /** A secret the sender generated, and how the sender signs with it. */
  signing: { signature: WebhookSignature; secret: string } | null;
  /** A credential whose secret store did not answer; a delivery nothing else accepts gets 503. */
  unavailable: boolean;
};

export type InboundTarget = {
  bot: Pick<WebhookTarget["bot"], "id" | "spaceId" | "userId">;
  threadId: string;
};

export function parseWebhookPayload(
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

const WEBHOOK_SECRET_CACHE_MAX = 1_000;

type WebhookSecretCacheEntry = {
  secretId: string;
  ciphertext: string;
  plaintext: Promise<string | null>;
  expires: number;
};

/**
 * Webhook secrets by bot id, and signing secrets by `signingCacheKey`; the decrypt promise is
 * shared so concurrent misses decrypt once.
 */
export type WebhookSecretCache = Map<string, WebhookSecretCacheEntry>;

const subscribedWebhookCaches = new WeakMap<SecretStore, WeakSet<WebhookSecretCache>>();
function subscribeWebhookCache(secrets: SecretStore, cache: WebhookSecretCache): void {
  let caches = subscribedWebhookCaches.get(secrets);
  if (!caches) {
    caches = new WeakSet();
    subscribedWebhookCaches.set(secrets, caches);
  }
  if (caches.has(cache)) return;
  caches.add(cache);
  secrets.onChange?.((ref) => {
    for (const [botId, entry] of cache) if (entry.ciphertext === ref) cache.delete(botId);
  });
}

function signingCacheKey(botId: string): string {
  return `${botId}:signing`;
}

function forgetWebhookSecrets(cache: WebhookSecretCache, botId: string) {
  cache.delete(botId);
  cache.delete(signingCacheKey(botId));
}

function touchWebhookSecret(
  cache: WebhookSecretCache,
  key: string,
  entry: WebhookSecretCacheEntry,
) {
  // Re-insert so the least recently delivered bot is evicted first.
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size <= WEBHOOK_SECRET_CACHE_MAX) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

function decryptWebhookSecret(
  secrets: WebhookDeps["secrets"],
  cache: WebhookSecretCache,
  key: string,
  secret: { id: string; ciphertext: string },
): WebhookSecretCacheEntry {
  const entry: WebhookSecretCacheEntry = {
    secretId: secret.id,
    ciphertext: secret.ciphertext,
    plaintext: Promise.resolve(null),
    expires: Date.now() + 30_000,
  };
  entry.plaintext = secrets.load(secret.ciphertext, secret.id).catch((error: unknown) => {
    // Auth and malformed ciphertext stay unusable. Anything else can clear, so retry it.
    if (
      (error instanceof SecretStoreUnavailableError || !isPermanentDecryptFailure(error)) &&
      cache.get(key) === entry
    )
      cache.delete(key);
    if (error instanceof SecretStoreUnavailableError) throw error;
    return null;
  });
  return entry;
}

// One decrypt per secret; v2 scrypt runs off the event loop.
function loadWebhookSecret(
  secrets: WebhookDeps["secrets"],
  cache: WebhookSecretCache,
  key: string,
  secret: { id: string; ciphertext: string },
): Promise<string | null> {
  subscribeWebhookCache(secrets, cache);
  const cached = cache.get(key);
  const entry =
    cached?.secretId === secret.id &&
    cached.ciphertext === secret.ciphertext &&
    cached.expires > Date.now()
      ? cached
      : decryptWebhookSecret(secrets, cache, key, secret);
  touchWebhookSecret(cache, key, entry);
  return entry.plaintext;
}

/** The bot's secret of this kind, or null when it is unset, not the bot's own, or unreadable. */
async function loadBotWebhookSecret(
  deps: Pick<WebhookDeps, "prisma" | "secrets">,
  cache: WebhookSecretCache,
  key: string,
  bot: { userId: string; spaceId: string },
  secretId: string | null,
  kind: string,
): Promise<string | null> {
  if (!secretId) {
    cache.delete(key);
    return null;
  }
  const secret = await deps.prisma.secret.findUnique({
    where: { id: secretId },
    select: { id: true, ciphertext: true, kind: true, userId: true, spaceId: true },
  });
  if (
    !secret ||
    secret.kind !== kind ||
    secret.userId !== bot.userId ||
    secret.spaceId !== bot.spaceId
  ) {
    cache.delete(key);
    return null;
  }
  return loadWebhookSecret(deps.secrets, cache, key, secret);
}

/** `signing: false` leaves the sender's signing secret unread, for a route that never checks it. */
export async function loadWebhookTarget(
  deps: Pick<WebhookDeps, "prisma" | "secrets">,
  cache: WebhookSecretCache,
  botId: string,
  options: { signing: boolean },
): Promise<WebhookTarget | null> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId, archivedAt: null },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      webhookSecretId: true,
      webhookSigningSecretId: true,
      webhookSignature: true,
      thread: { select: { id: true } },
    },
  });
  const signature = bot ? botWebhookSignature(bot) : null;
  const signingSecretId = (options.signing && signature && bot?.webhookSigningSecretId) || null;

  // A deactivated owner's bot takes no deliveries; callers see the usual unauthorized reply.
  if (
    !bot?.thread ||
    (!bot.webhookSecretId && !signingSecretId) ||
    (await accountDeactivated(deps.prisma, bot.userId))
  ) {
    forgetWebhookSecrets(cache, botId);
    return null;
  }

  // An outage loading one credential must not block deliveries the other one accepts.
  const loaded = await Promise.allSettled([
    loadBotWebhookSecret(deps, cache, botId, bot, bot.webhookSecretId, WEBHOOK_SECRET_KIND),
    loadBotWebhookSecret(
      deps,
      cache,
      signingCacheKey(botId),
      bot,
      signingSecretId,
      WEBHOOK_SIGNING_SECRET_KIND,
    ),
  ]);
  for (const result of loaded) {
    if (result.status === "rejected" && !(result.reason instanceof SecretStoreUnavailableError))
      throw result.reason;
  }
  const [expected, signingSecret] = loaded.map((result) =>
    result.status === "fulfilled" ? result.value : null,
  );
  if (expected == null && signingSecret == null && loaded.every((r) => r.status === "fulfilled"))
    return null;

  const current = await deps.prisma.bot.findUnique({
    where: { id: botId, archivedAt: null },
    select: { webhookSecretId: true, webhookSigningSecretId: true },
  });
  // Rotation can commit during decrypt, so a credential read above may already be revoked. Only
  // that credential is dropped: a delivery the other one accepts still runs.
  const revoked = (key: string, read: string | null, now: string | null | undefined) => {
    if (read === (now ?? null)) return false;
    if (read && cache.get(key)?.secretId === read) cache.delete(key);
    return true;
  };
  const ownRevoked = revoked(botId, bot.webhookSecretId, current?.webhookSecretId);
  const signingRevoked = revoked(
    signingCacheKey(botId),
    bot.webhookSigningSecretId,
    current?.webhookSigningSecretId,
  );
  const [own, signing] = loaded;
  const target = {
    expected: ownRevoked ? null : (expected ?? null),
    signing:
      !signingRevoked && signature && signingSecret != null
        ? { signature, secret: signingSecret }
        : null,
    unavailable:
      (!ownRevoked && own.status === "rejected") ||
      (!signingRevoked && signing.status === "rejected"),
  };
  if (target.expected === null && target.signing === null && !target.unavailable) return null;

  return {
    bot: { id: bot.id, spaceId: bot.spaceId, userId: bot.userId },
    threadId: bot.thread.id,
    ...target,
  };
}

/**
 * Answers an authenticated delivery. A Space being deleted takes none: the sender gets a 409, not
 * a server error, so the request is not reported as a failure.
 */
export async function webhookDeliveryResponse(
  c: Context,
  delivery: ReturnType<typeof deliverWebhookEvent>,
): Promise<Response> {
  try {
    return c.json(await delivery);
  } catch (error) {
    if (error instanceof SpaceDeletionInProgressError)
      return c.json({ error: "Space deletion in progress" }, 409);
    throw error;
  }
}

export async function deliverWebhookEvent(
  deps: Pick<WebhookDeps, "events" | "jobs">,
  target: InboundTarget,
  input: {
    prompt: string;
    attachmentBlocks?: Extract<MessageBlock, { kind: "file" | "image" }>[];
    routines: Array<{
      name: string;
      prompt: string;
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
    }>;
    source: InboundSource;
    idempotencyKey?: string;
    /** Messaging wakes share the live chat thread; keep a separate webhook run. */
    allowParallelRun?: boolean;
    /** Claims what the wake answers in the transaction that starts its run. */
    claim?: SendUserMessageInput["claim"];
  },
) {
  const promptText =
    input.routines.length > 0
      ? [
          ...input.routines.map(inboundRoutineBlock),
          "",
          input.source === "github"
            ? "Inbound GitHub event metadata:"
            : input.source === "messaging"
              ? "Inbound messaging event:"
              : input.source === "email"
                ? "Inbound email:"
                : "Inbound webhook payload:",
          input.prompt,
        ].join("\n")
      : input.prompt;

  const clientNonce = input.idempotencyKey
    ? inboundDeliveryClientNonce(input.source, target.bot.id, input.idempotencyKey)
    : undefined;
  const pin = inboundRoutineModelPin(input.routines);

  const sent = await deps.events.sendUserMessage({
    spaceId: target.bot.spaceId,
    threadId: target.threadId,
    botId: target.bot.id,
    userId: target.bot.userId,
    blocks: [
      { kind: "delivery" },
      { kind: "text", text: promptText },
      ...(input.attachmentBlocks ?? []),
    ],
    prompt: promptText,
    trigger: "webhook",
    clientNonce,
    ...(input.allowParallelRun ? { allowParallelRun: true } : {}),
    ...(input.claim ? { claim: input.claim } : {}),
    ...(pin.modelProvider && pin.modelId
      ? {
          modelPin: {
            modelProvider: pin.modelProvider,
            modelId: pin.modelId,
            thinkingLevel: pin.thinkingLevel ?? null,
          },
        }
      : {}),
  });

  if (sent.runId) {
    await wakeRun(deps.jobs, sent.runId);
  }

  return { ok: true as const, messageId: sent.messageId, runId: sent.runId, seq: sent.seq };
}
