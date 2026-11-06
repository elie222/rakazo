import { createHash } from "node:crypto";
import type { MessagingInboundAttachment } from "@rakazo/adapter-kit";
import type { InboundEmail } from "@rakazo/adapters";
import { INBOUND_EMAIL_MAX_BYTES, readInboundEmail } from "@rakazo/adapters";
import type { RoutineEmailSenders } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import {
  AttachmentValidationError,
  hasValidBearerToken,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type { ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { cancelBody, readBoundedBytes } from "./http-body.js";
import type { WebhookDeps } from "./webhook-inbound.js";
import { deliverWebhookEvent, formatUntrustedDeliveryPayload } from "./webhook-inbound.js";

export const INBOUND_EMAIL_PATH = "/api/v1/email/inbound";

export type EmailInboundDeps = Pick<WebhookDeps, "prisma" | "jobs"> & {
  events: WebhookDeps["events"] & Pick<ThreadEvents, "notify">;
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
    const result = await receiveBotEmail(deps, c.req.query("to") ?? "", raw);
    // The relay keeps the message and tries again, as for any other temporary failure.
    if ("retry" in result) return c.json({ error: "Try again later" }, 503);
    return c.json(result);
  });
}

export async function receiveBotEmail(deps: EmailInboundDeps, recipient: string, raw: Uint8Array) {
  const dropped: { botId?: string; senderDomain?: string } = {};
  // Logged without addresses or content, so an owner's lost mail can be explained.
  const ignored = (reason: string) => {
    getLogger().info("inbound email dropped", { reason, ...dropped });
    return { ok: true as const, ignored: reason };
  };
  const target = recipientName(recipient, deps.domain);
  if (!target) return ignored("not this server's domain");

  const claimed = await deps.prisma.botEmailAddress.findUnique({
    where: { name: target },
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
  dropped.botId = bot.id;

  // The run acts as the bot's owner, so only their own routines may ride on it.
  const emailRoutine = { botId: bot.id, spaceId: bot.spaceId, userId: bot.userId, active: true };
  // Cheap check first: most mail to a bot without an email routine is never parsed.
  const any = await deps.prisma.routine.findFirst({
    where: { ...emailRoutine, emailSenders: { not: null } },
    select: { id: true },
  });
  if (!any) return ignored("no email routine");

  let email: InboundEmail;
  try {
    email = await (deps.readEmail ?? readInboundEmail)(raw);
  } catch (error) {
    getLogger().warn("inbound email was unreadable", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return ignored("unreadable");
  }
  if (email.from) dropped.senderDomain = domainOf(email.from.address);
  if (email.automated) return ignored("automated");
  if (email.from && !email.authenticated && email.temporaryFailure) {
    getLogger().warn("inbound email signature could not be checked yet", dropped);
    return { retry: true as const };
  }
  if (!email.from) return ignored("unauthenticated");
  const sender = email.from.address;
  // The rule only decides who may start the owner's own bot, so an address the owner never
  // verified can expose nothing but that owner's account; servers without email verify no one.
  const owner = await deps.prisma.user.findUnique({
    where: { id: bot.userId },
    select: { email: true },
  });
  const ownerEmail = owner?.email.trim().toLowerCase() || null;
  const named = [...email.to, ...email.cc].some(
    (address) => recipientName(address, deps.domain) === target,
  );
  if (!email.authenticated) {
    // BCC'd mail is dropped whatever its signature, so it never earns a note either.
    if (sender === ownerEmail && named) {
      await noteUnverifiedOwnerMail(
        deps,
        { id: bot.id, spaceId: bot.spaceId, threadId: bot.thread.id },
        target,
      );
    }
    return ignored("unauthenticated");
  }
  if (domainOf(sender) === deps.domain) return ignored("from a bot");
  // A signed message replayed to the bot does not name it; BCC does not either.
  if (!named) {
    return ignored("not addressed to this bot");
  }

  const allowed: RoutineEmailSenders[] =
    ownerEmail === null
      ? []
      : sender === ownerEmail
        ? ["owner", "domain"]
        : domainOf(sender) === domainOf(ownerEmail)
          ? ["domain"]
          : [];
  // Filtered in the query, so routines this sender cannot start never crowd out ones it can.
  const matched = allowed.length
    ? await deps.prisma.routine.findMany({
        where: { ...emailRoutine, emailSenders: { in: allowed } },
        select: {
          name: true,
          prompt: true,
          modelProvider: true,
          modelId: true,
          thinkingLevel: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 5,
      })
    : [];
  if (matched.length === 0) return ignored("sender not allowed");

  const keyHash = createHash("sha256").update(email.key).digest("base64url");
  const artifacts: Array<{ id: string; name: string; mimeType: string; size: number }> = [];
  const unavailable: string[] = [];
  for (const [index, file] of email.attachments.entries()) {
    const label = `[file: ${sanitizeMessagingLabel(file.name)} (unavailable)]`;
    // Counts what was kept, so a refused file never takes one of the slots.
    if (!deps.storeAttachment || artifacts.length >= ATTACHMENT_MAX_COUNT) {
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
      // A storage or database failure is temporary: fail the request so the relay retries.
      // Files already stored are found again by their nonces, never stored twice.
      if (!(error instanceof AttachmentValidationError)) throw error;
      getLogger().warn("email attachment was not stored", {
        reason: error instanceof Error ? error.message : String(error),
      });
      unavailable.push(label);
    }
  }

  const name = email.from.name.slice(0, HEADER_MAX_CHARS);
  const prompt = formatUntrustedDeliveryPayload("[Email]", {
    from: name ? `${name} <${sender}>` : sender,
    to: listed(email.to),
    ...(email.cc.length ? { cc: listed(email.cc) } : {}),
    subject: email.subject.slice(0, HEADER_MAX_CHARS),
    ...(email.date ? { date: email.date } : {}),
    text: email.text,
    ...(artifacts.length
      ? { files: artifacts.map(({ name, mimeType, size }) => ({ name, mimeType, size })) }
      : {}),
    ...(unavailable.length ? { unavailable: listed(unavailable) } : {}),
  });

  return deliverWebhookEvent(
    deps,
    { bot: { id: bot.id, spaceId: bot.spaceId, userId: bot.userId }, threadId: bot.thread.id },
    { prompt, artifacts, routines: matched, source: "email", idempotencyKey: email.key },
  );
}

/** How often the owner hears that their own mail could not be verified. */
const UNVERIFIED_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Mail that claims the owner's address but fails the signature check is usually the owner's own,
 * from a mail domain that does not sign as itself. Say so in the bot's chat, at most once a day,
 * without any of the message: it may be forged.
 */
async function noteUnverifiedOwnerMail(
  deps: EmailInboundDeps,
  bot: { id: string; spaceId: string; threadId: string },
  name: string,
) {
  const due = new Date(Date.now() - UNVERIFIED_NOTICE_INTERVAL_MS);
  const blocks = [{ kind: "meta" as const, text: UNVERIFIED_OWNER_MAIL_NOTE }];
  // The claim and the note commit together: instances receiving copies at once post one note,
  // and a note that fails to save leaves the day's slot free for the next message.
  const seq = await deps.prisma.$transaction(async (tx) => {
    const claimed = await tx.botEmailAddress.updateMany({
      where: {
        name,
        botId: bot.id,
        OR: [{ unverifiedNoticeAt: null }, { unverifiedNoticeAt: { lt: due } }],
      },
      data: { unverifiedNoticeAt: new Date() },
    });
    if (claimed.count !== 1) return undefined;
    const message = await createThreadMessageInTransaction(tx, {
      threadId: bot.threadId,
      botId: bot.id,
      role: "system",
      blocks,
      // The owner should see it even while away from the bot's chat.
      markUnread: true,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: bot.spaceId,
      threadId: bot.threadId,
      botId: bot.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "system", blocks },
    });
    return event.seq;
  });
  if (seq !== undefined) await deps.events.notify(bot.threadId, seq).catch(() => undefined);
}

export const UNVERIFIED_OWNER_MAIL_NOTE =
  "An email from your address couldn't be verified, so no routine ran.";

/** Longest subject or sender name the bot sees; only the body has its own, larger cap. */
const HEADER_MAX_CHARS = 500;
const LIST_MAX_ENTRIES = 50;

/** A long recipient or file list, cut so it cannot crowd out the email itself. */
function listed(items: string[]): string[] {
  return items.length > LIST_MAX_ENTRIES
    ? [...items.slice(0, LIST_MAX_ENTRIES), `[${items.length - LIST_MAX_ENTRIES} more]`]
    : items;
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
