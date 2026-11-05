import { createHash } from "node:crypto";
import type { MessagingInboundAttachment } from "@rakazo/adapter-kit";
import type { InboundEmail } from "@rakazo/adapters";
import { INBOUND_EMAIL_MAX_BYTES, readInboundEmail } from "@rakazo/adapters";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import { hasValidBearerToken, sanitizeMessagingLabel } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { cancelBody, readBoundedBytes } from "./http-body.js";
import type { WebhookDeps } from "./webhook-inbound.js";
import { deliverWebhookEvent, formatUntrustedDeliveryPayload } from "./webhook-inbound.js";

export const INBOUND_EMAIL_PATH = "/api/v1/email/inbound";

export type EmailInboundDeps = Pick<WebhookDeps, "prisma" | "events" | "jobs"> & {
  domain: string;
  secret: string;
  storeAttachment?: (input: {
    spaceId: string;
    userId: string;
    botId: string;
    attachment: MessagingInboundAttachment;
    clientNonce: string;
  }) => Promise<{ id: string; name: string; mimeType: string; size: number }>;
  /** Parses and authenticates the raw message; tests pass a fixed one. */
  readEmail?: (raw: Uint8Array) => Promise<InboundEmail>;
};

/**
 * A mail relay posts each message raw, once per envelope recipient, with the
 * recipient in `?to=`. Anything that is not work for a bot is accepted and
 * dropped, so the relay never retries or bounces it.
 */
export function mountEmailInboundRoute(app: Hono, deps: EmailInboundDeps) {
  app.post(INBOUND_EMAIL_PATH, async (c) => {
    if (!hasValidBearerToken(c.req.header("authorization"), deps.secret)) {
      cancelBody(c.req.raw.body);
      return c.json({ error: "Unauthorized" }, 401);
    }
    const raw = await readBoundedBytes(c.req.raw, INBOUND_EMAIL_MAX_BYTES);
    if (raw === null) return c.json({ error: "Payload too large" }, 413);
    return c.json(await receiveBotEmail(deps, c.req.query("to") ?? "", raw));
  });
}

export async function receiveBotEmail(deps: EmailInboundDeps, recipient: string, raw: Uint8Array) {
  const ignored = (reason: string) => ({ ok: true as const, ignored: reason });
  const target = recipientName(recipient, deps.domain);
  if (!target) return ignored("not this server's domain");

  const claimed = await deps.prisma.botEmailAddress.findUnique({
    where: { localPart: target },
    select: {
      bot: {
        select: {
          id: true,
          spaceId: true,
          userId: true,
          archivedAt: true,
          thread: { select: { id: true } },
        },
      },
    },
  });
  const bot = claimed?.bot;
  if (!bot || bot.archivedAt || !bot.thread) return ignored("no such bot");

  const routines = await deps.prisma.routine.findMany({
    where: { botId: bot.id, spaceId: bot.spaceId, active: true, emailSenders: { not: null } },
    select: {
      id: true,
      name: true,
      prompt: true,
      emailSenders: true,
      modelProvider: true,
      modelId: true,
      thinkingLevel: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
  if (routines.length === 0) return ignored("no email routine");

  let email: InboundEmail;
  try {
    email = await (deps.readEmail ?? readInboundEmail)(raw);
  } catch (error) {
    getLogger().warn("inbound email was unreadable", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return ignored("unreadable");
  }
  if (email.automated) return ignored("automated");
  if (!email.from || !email.authenticated) return ignored("unauthenticated");
  const sender = email.from.address;
  if (domainOf(sender) === deps.domain) return ignored("from a bot");
  // A signed message replayed to the bot does not name it; BCC does not either.
  if (
    ![...email.to, ...email.cc].some((address) => recipientName(address, deps.domain) === target)
  ) {
    return ignored("not addressed to this bot");
  }

  const owner = await deps.prisma.user.findUnique({
    where: { id: bot.userId },
    select: { email: true, emailVerified: true },
  });
  const ownerEmail = owner?.emailVerified ? owner.email.trim().toLowerCase() : null;
  const matched = routines.filter((routine) =>
    routine.emailSenders === "owner"
      ? sender === ownerEmail
      : routine.emailSenders === "domain" &&
        ownerEmail !== null &&
        domainOf(sender) === domainOf(ownerEmail),
  );
  if (matched.length === 0) return ignored("sender not allowed");

  const keyHash = createHash("sha256").update(email.key).digest("base64url");
  const artifacts: Array<{ id: string; name: string; mimeType: string; size: number }> = [];
  const unavailable: string[] = [];
  for (const [index, file] of email.attachments.entries()) {
    const label = `[file: ${sanitizeMessagingLabel(file.name)} (unavailable)]`;
    if (!deps.storeAttachment || index >= ATTACHMENT_MAX_COUNT) {
      unavailable.push(label);
      continue;
    }
    try {
      const { id, name, mimeType, size } = await deps.storeAttachment({
        spaceId: bot.spaceId,
        userId: bot.userId,
        botId: bot.id,
        attachment: {
          name: file.name,
          mimeType: file.mimeType,
          size: file.bytes.byteLength,
          fetch: async () => file.bytes,
        },
        clientNonce: `email-attachment:${bot.id}:${keyHash}:${index}`,
      });
      artifacts.push({ id, name, mimeType, size });
    } catch (error) {
      getLogger().warn("email attachment was not stored", {
        reason: error instanceof Error ? error.message : String(error),
      });
      unavailable.push(label);
    }
  }

  const prompt = formatUntrustedDeliveryPayload("[Email]", {
    from: email.from.name ? `${email.from.name} <${sender}>` : sender,
    to: email.to,
    ...(email.cc.length ? { cc: email.cc } : {}),
    subject: email.subject,
    ...(email.date ? { date: email.date } : {}),
    text: email.text,
    ...(artifacts.length
      ? { files: artifacts.map(({ name, mimeType, size }) => ({ name, mimeType, size })) }
      : {}),
    ...(unavailable.length ? { unavailable } : {}),
  });

  return deliverWebhookEvent(
    deps,
    { bot: { id: bot.id, spaceId: bot.spaceId, userId: bot.userId }, threadId: bot.thread.id },
    { prompt, artifacts, routines: matched, source: "email", idempotencyKey: email.key },
  );
}

/** The bot name an address on this domain reaches; a +tag reaches the same bot. */
function recipientName(address: string, domain: string): string | null {
  const at = address.lastIndexOf("@");
  if (
    at <= 0 ||
    address
      .slice(at + 1)
      .trim()
      .toLowerCase() !== domain
  )
    return null;
  // An unencoded "+" in ?to= arrives as a space; addresses never contain one.
  return address.slice(0, at).trim().toLowerCase().split(/[+ ]/)[0] || null;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}
