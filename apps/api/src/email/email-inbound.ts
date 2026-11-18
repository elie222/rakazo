import { createHash } from "node:crypto";
import type { MessagingInboundAttachment } from "@rakazo/adapter-kit";
import type { InboundEmail } from "@rakazo/adapters";
import { INBOUND_EMAIL_MAX_BYTES, readInboundEmail } from "@rakazo/adapters";
import type { RoutineEmailSenders } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import { AttachmentValidationError, sanitizeMessagingLabel } from "@rakazo/core";
import { hasValidBearerToken } from "@rakazo/core/node/secrets-guard";
import type { EmailAttachment, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  isUniqueViolation,
  SpaceDeletionInProgressError,
  storedEmailAttachments,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { cancelBody, readBoundedBytes } from "../http/http-body.js";
import {
  formatRoutineEmailPrompt,
  ownerEmailPrompt,
} from "../messaging/inbound-delivery.prompt.js";
import type { WebhookDeps } from "../webhooks/webhook-inbound.js";
import { deliverWebhookEvent } from "../webhooks/webhook-inbound.js";

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
    /** Never joins a same-name file's versions, so a stranger's file cannot become the current one. */
    standalone: boolean;
  }) => Promise<{ id: string; name: string; mimeType: string; size: number }>;
  /** Parses and authenticates the raw message; tests pass a fixed one. */
  readEmail?: (raw: Uint8Array) => Promise<InboundEmail>;
};

/**
 * A mail relay posts each message raw, once per envelope recipient, with the
 * recipient in `?to=`. Mail for a bot is saved to its inbox; anything else is
 * accepted and dropped, so the relay never retries or bounces it.
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
  // A routine takes the owner's address as given: it starts only that owner's own bot, and servers
  // without email verify no one. Mail that starts the bot with no routine needs it confirmed.
  const owner = await deps.prisma.user.findUnique({
    where: { id: bot.userId },
    select: { email: true, emailVerified: true, deactivatedAt: true },
  });
  // A deactivated owner's bot takes no mail, as it takes no webhook deliveries.
  if (owner?.deactivatedAt) return ignored("owner deactivated");

  let email: InboundEmail;
  try {
    email = deps.readEmail ? await deps.readEmail(raw) : await readInboundEmail(raw);
  } catch (error) {
    getLogger().warn("inbound email was unreadable", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return ignored("unreadable");
  }
  if (!email.from) return ignored("no sender");
  dropped.senderDomain = domainOf(email.from.address);
  // Saved as unverified, a message whose signature could be checked later would stay so.
  if (!email.authenticated && email.temporaryFailure) {
    getLogger().warn("inbound email signature could not be checked yet", dropped);
    return { retry: true as const };
  }

  const sender = email.from.address;
  const ownerEmail = owner?.email.trim().toLowerCase() || null;
  const named = (addresses: string[]) =>
    addresses.some((address) => recipientName(address, deps.domain) === target);
  const addressed = named(email.to) || named(email.cc);

  // Why nothing may start, before looking for a routine. A routine reads the mail as outside data,
  // so it needs a real sender but not signed recipients, which some mail services never sign.
  const ineligible = email.automated
    ? "automated"
    : !email.senderAuthenticated
      ? "unauthenticated"
      : domainOf(sender) === deps.domain
        ? "from a bot"
        : // A signed message replayed to the bot does not name it; BCC does not either.
          !addressed
          ? "not addressed to this bot"
          : null;
  // The owner's words are instructions, so they need more: recipients a forwarder could not have
  // edited, and a person behind them, which a mailbox rule's forward does not have.
  const notOwnerWords =
    ineligible ??
    (email.autoGenerated ? "automated" : !email.authenticated ? "unauthenticated" : null);
  const allowed: RoutineEmailSenders[] =
    ineligible || ownerEmail === null
      ? []
      : sender === ownerEmail
        ? ["owner", "domain"]
        : domainOf(sender) === domainOf(ownerEmail)
          ? ["domain"]
          : [];
  // Filtered in the query, so routines this sender cannot start never crowd out ones it can.
  const matched = allowed.length
    ? await deps.prisma.routine.findMany({
        where: {
          botId: bot.id,
          spaceId: bot.spaceId,
          // The run acts as the bot's owner, so only their own routines may ride on it.
          userId: bot.userId,
          active: true,
          emailSenders: { in: allowed },
        },
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
  // Without a routine, the owner's own mail to the bot starts it, as a chat message would: only
  // from an address they confirmed, and only sent to the bot, not copied on mail for someone else.
  const ownerMessage =
    !notOwnerWords && sender === ownerEmail && owner?.emailVerified === true && named(email.to);
  const starts = matched.length > 0 || ownerMessage;

  // Every message is saved, whoever sent it: sign-up codes and receipts come from strangers. The
  // daily cap stops only a flood of mail that starts nothing, never the owner's own.
  // A signed message replayed or BCC'd to the bot is real mail, but not mail for this bot: its
  // codes and links could be someone else's, so it is saved as unverified.
  const saved = await saveToInbox(deps, bot, email, email.from, {
    capped: !starts,
    verified: email.authenticated && addressed,
    keepFiles: starts || (email.authenticated && addressed),
    // Only mail that starts the bot and was provably written to it may add versions of the owner's
    // files: a readdressed copy could be an old one, and a rule's forward carries whatever a
    // stranger attached.
    standalone: !starts || !email.authenticated || email.autoGenerated,
  });
  if (!saved) return ignored("inbox full");
  if (!starts) {
    // BCC'd mail never starts anything whatever its signature, so it never earns a note either.
    if (!email.authenticated && sender === ownerEmail && addressed) {
      await noteUnverifiedOwnerMail(
        deps,
        { id: bot.id, spaceId: bot.spaceId, threadId: bot.thread.id },
        target,
      );
    }
    const reason = (sender === ownerEmail ? notOwnerWords : ineligible) ?? "sender not allowed";
    getLogger().info("inbound email saved without a run", {
      reason,
      ...(email.unauthenticatedReason
        ? { unauthenticatedReason: email.unauthenticatedReason }
        : {}),
      ...dropped,
    });
    return { ok: true as const, saved: true, skipped: reason };
  }

  const artifacts = saved.files.flatMap((file) =>
    file.artifactId
      ? [{ id: file.artifactId, name: file.name, mimeType: file.mimeType, size: file.size }]
      : [],
  );
  const unavailable = saved.files
    .filter((file) => !file.artifactId)
    .map((file) => `[file: ${sanitizeMessagingLabel(file.name)} (unavailable)]`);
  const name = email.from.name.slice(0, HEADER_MAX_CHARS);
  const payload = {
    id: saved.id,
    from: name ? `${name} <${sender}>` : sender,
    to: listed(email.to),
    ...(email.cc.length ? { cc: listed(email.cc) } : {}),
    subject: email.subject.slice(0, HEADER_MAX_CHARS),
    ...(email.date ? { date: email.date } : {}),
    text: email.modelText,
    ...(artifacts.length
      ? { files: artifacts.map(({ name, mimeType, size }) => ({ name, mimeType, size })) }
      : {}),
    ...(unavailable.length ? { unavailable: listed(unavailable) } : {}),
  };
  const prompt = matched.length ? formatRoutineEmailPrompt(payload) : ownerEmailPrompt(payload);

  return deliverWebhookEvent(
    deps,
    { bot: { id: bot.id, spaceId: bot.spaceId, userId: bot.userId }, threadId: bot.thread.id },
    {
      prompt,
      attachmentBlocks: artifacts.map(({ id, name, mimeType, size }) => ({
        kind: "file",
        artifactId: id,
        name,
        mimeType,
        size,
      })),
      routines: matched,
      source: "email",
      idempotencyKey: email.key,
    },
  ).catch((error: unknown) => {
    if (error instanceof SpaceDeletionInProgressError) return ignored("space being deleted");
    throw error;
  });
}

/** Messages one bot saves per day; past it, a flood of mail stops being stored. */
export const INBOX_DAILY_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_STORED_MAX = 100;

/** A file of a saved email: kept as an artifact, or named only because it was refused. */
export type InboxFile = EmailAttachment;

/** Save the message to the bot's inbox once, or find it saved; null when the inbox is full. */
async function saveToInbox(
  deps: EmailInboundDeps,
  bot: { id: string; spaceId: string; userId: string },
  email: InboundEmail,
  from: NonNullable<InboundEmail["from"]>,
  options: { capped: boolean; verified: boolean; keepFiles: boolean; standalone: boolean },
): Promise<{ id: string; files: InboxFile[] } | null> {
  const where = { botId_key: { botId: bot.id, key: email.key } };
  const select = { id: true, attachments: true } as const;
  const found = await deps.prisma.botEmailMessage.findUnique({ where, select });
  // A copy that did not name the bot is saved without its files; one that has earned them adds them.
  const saved = async (row: { id: string; attachments: unknown }, stored?: InboxFile[]) => {
    const files = storedEmailAttachments(row);
    // Inline-only mail can have a saved empty list. An unreadable list cannot be replaced.
    const emptyList = Array.isArray(row.attachments) && row.attachments.length === 0;
    if (
      !options.keepFiles ||
      !email.attachments.length ||
      (!files.length && !emptyList) ||
      files.some((file) => file.artifactId)
    ) {
      return { id: row.id, files };
    }
    const kept = stored ?? (await storeAttachments(deps, bot, email, options.standalone));
    // Only a kept file is worth writing, so a copy whose files were refused never undoes another's.
    if (kept.some((file) => file.artifactId)) {
      await deps.prisma.botEmailMessage.update({ where, data: { attachments: kept } });
    }
    return { id: row.id, files: kept };
  };
  if (found) return saved(found);
  if (options.capped) {
    const recent = await deps.prisma.botEmailMessage.count({
      where: { botId: bot.id, sent: false, receivedAt: { gte: new Date(Date.now() - DAY_MS) } },
    });
    if (recent >= INBOX_DAILY_LIMIT) return null;
  }

  // Files cost the owner storage, so only a sender who proved their address gets them kept.
  const files = options.keepFiles
    ? await storeAttachments(deps, bot, email, options.standalone)
    : email.attachments
        .filter((file) => !file.inline)
        .map((file) => ({ name: file.name.slice(0, HEADER_MAX_CHARS) }));
  try {
    const row = await deps.prisma.botEmailMessage.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        key: email.key,
        messageId: email.messageId,
        references: email.references,
        fromAddress: from.address,
        fromName: from.name.slice(0, HEADER_MAX_CHARS),
        verified: options.verified,
        to: email.to.slice(0, LIST_STORED_MAX),
        cc: email.cc.slice(0, LIST_STORED_MAX),
        subject: email.subject.slice(0, HEADER_MAX_CHARS),
        text: email.text,
        attachments: files,
      },
      select,
    });
    return { id: row.id, files };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another delivery of the same message saved it first; its files have the same nonces.
    return saved(await deps.prisma.botEmailMessage.findUniqueOrThrow({ where, select }), files);
  }
}

async function storeAttachments(
  deps: EmailInboundDeps,
  bot: { id: string; spaceId: string; userId: string },
  email: InboundEmail,
  standalone: boolean,
): Promise<InboxFile[]> {
  const keyHash = createHash("sha256").update(email.key).digest("base64url");
  const files: InboxFile[] = [];
  let kept = 0;
  // Retain the original index for storage nonces while giving explicit files first use of slots.
  const ordered = Array.from(email.attachments.entries()).sort(
    ([, left], [, right]) => Number(Boolean(left.inline)) - Number(Boolean(right.inline)),
  );
  for (const [index, file] of ordered) {
    const name = file.name.slice(0, HEADER_MAX_CHARS);
    // Counts what was kept, so a refused file never takes one of the slots.
    if (!deps.storeAttachment || kept >= ATTACHMENT_MAX_COUNT) {
      if (!file.inline) files.push({ name });
      continue;
    }
    try {
      const stored = await deps.storeAttachment({
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
        standalone: standalone || file.inline === true,
      });
      kept += 1;
      files.push({
        artifactId: stored.id,
        name: stored.name,
        mimeType: stored.mimeType,
        size: stored.size,
      });
    } catch (error) {
      // A storage or database failure is temporary: fail the request so the relay retries.
      // Files already stored are found again by their nonces, never stored twice.
      if (!(error instanceof AttachmentValidationError)) throw error;
      if (file.inline) continue;
      getLogger().warn("email attachment was not stored", {
        reason: error instanceof Error ? error.message : String(error),
      });
      files.push({ name });
    }
  }
  return files;
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
  "An email from your address couldn't be verified, so it wasn't acted on.";

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
