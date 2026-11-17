import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  ClientError,
  EmailReplyDraftError,
  emailReplyBlock,
  emailReplyDraftFromBlock,
  emailReplyOutbound,
  emailReplyWithStatus,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  changeMessageBlocks,
  isUniqueViolation,
  reserveBotEmailSend,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import type { RouterDeps } from "./router.js";

type EmailReplyAction =
  | {
      type: "save" | "send";
      inReplyTo: string;
      to: string[];
      cc: string[];
      subject: string;
      body: string;
      approval: "needs_approval" | "send_once";
    }
  | { type: "discard" };

type CommitInput = {
  threadId: string;
  messageId: string;
  draftId: string;
  action: EmailReplyAction;
};

const ALLOWANCE = {
  limit: "Your account has reached its email allowance for the last 24 hours. Try again later.",
  too_many:
    "This email has more recipients than your account's allowance. Send to fewer recipients.",
  disabled: "Email sending is paused for this account.",
  unverified: "Verify your account email before sending.",
  recipient: "This recipient isn't approved for this account.",
} as const;

/** Writes the draft back onto its message. Send delivers the mail before the draft is sent. */
export async function commitEmailReply(
  deps: Pick<RouterDeps, "prisma" | "email" | "env" | "events">,
  actor: Actor,
  input: CommitInput,
) {
  const loaded = await loadDraft(deps, actor, input);
  if (input.action.type === "discard") {
    if (loaded.block.status === "sent") {
      throw new ClientError("CONFLICT", "This draft was already sent");
    }
    const draft = emailReplyWithStatus(emailReplyDraftFromBlock(loaded.block), "discarded");
    return storeBlock(deps, loaded, emailReplyBlock(draft));
  }

  const draft = emailReplyDraftFromBlock({
    ...loaded.block,
    inReplyTo: input.action.inReplyTo,
    to: input.action.to,
    cc: input.action.cc,
    subject: input.action.subject,
    body: input.action.body,
    approval: input.action.approval,
  });
  if (input.action.type === "save") {
    if (loaded.block.status !== "ready") {
      throw new ClientError("CONFLICT", "This draft is no longer editable");
    }
    return storeBlock(deps, loaded, emailReplyBlock(draft));
  }

  if (loaded.block.status === "sent") return loaded.block;
  if (loaded.block.status === "discarded") {
    throw new ClientError("CONFLICT", "This draft was discarded");
  }
  let mail: ReturnType<typeof emailReplyOutbound>;
  try {
    mail = emailReplyOutbound(draft);
  } catch (error) {
    if (error instanceof EmailReplyDraftError) throw new ClientError("BAD_REQUEST", error.message);
    throw error;
  }
  await deliver(deps, loaded, mail);
  return storeBlock(deps, loaded, emailReplyBlock(emailReplyWithStatus(draft, "sent")));
}

async function loadDraft(deps: Pick<RouterDeps, "prisma">, actor: Actor, input: CommitInput) {
  const message = await deps.prisma.message.findFirst({
    where: { id: input.messageId, threadId: input.threadId },
  });
  if (!message?.botId) throw new ClientError("NOT_FOUND", "That draft is not in this chat");
  const block = storedMessageBlocks(message).find(
    (entry) => entry.kind === "email_reply" && entry.draftId === input.draftId,
  );
  if (block?.kind !== "email_reply")
    throw new ClientError("NOT_FOUND", "That draft is not in this chat");
  const bot = await deps.prisma.bot.findFirst({
    where: { id: message.botId, spaceId: actor.spaceId },
    select: { id: true, userId: true, name: true, spaceId: true },
  });
  if (!bot) throw new ClientError("NOT_FOUND", "That draft is not in this chat");
  return { message, block, bot, actor };
}

async function deliver(
  deps: Pick<RouterDeps, "prisma" | "email" | "env">,
  loaded: Awaited<ReturnType<typeof loadDraft>>,
  mail: ReturnType<typeof emailReplyOutbound>,
) {
  if (loaded.bot.userId !== loaded.actor.userId) {
    throw new ClientError("FORBIDDEN", "Only the bot's owner can send this email.");
  }
  const domain = deps.env.inboundEmailDomain;
  if (!deps.email || !domain)
    throw new ClientError("SERVICE_UNAVAILABLE", "This server can't send email.");
  const named = await deps.prisma.botEmailAddress.findUnique({
    where: { botId: loaded.bot.id },
    select: { name: true },
  });
  if (!named) throw new ClientError("BAD_REQUEST", "This bot does not have an email address yet.");
  const address = `${named.name}@${domain}`;
  if (mail.from.toLowerCase() !== address.toLowerCase()) {
    throw new ClientError("BAD_REQUEST", "This draft is not from this bot's address.");
  }
  if (mail.to.length + mail.cc.length > 10) {
    throw new ClientError("BAD_REQUEST", "Send to at most 10 people at once.");
  }
  const reserved = await reserveBotEmailSend(deps.prisma, {
    userId: loaded.bot.userId,
    botId: loaded.bot.id,
    recipients: [...mail.to, ...mail.cc],
  });
  if (typeof reserved === "string") throw new ClientError("BAD_REQUEST", ALLOWANCE[reserved]);
  const key = `card:${loaded.message.id}:${mail.draftId}`;
  const earlier = await deps.prisma.botEmailMessage.findUnique({
    where: { botId_key: { botId: loaded.bot.id, key } },
    select: { id: true },
  });
  if (earlier) {
    throw new ClientError(
      "CONFLICT",
      "An earlier attempt to send this email was interrupted and may or may not have gone out.",
    );
  }
  try {
    await deps.prisma.botEmailMessage.create({
      data: {
        spaceId: loaded.bot.spaceId,
        botId: loaded.bot.id,
        key,
        references: [],
        fromAddress: address,
        fromName: loaded.bot.name,
        verified: true,
        sent: true,
        to: mail.to,
        cc: mail.cc,
        subject: mail.subject,
        text: mail.body,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ClientError(
        "CONFLICT",
        "An earlier attempt to send this email was interrupted and may or may not have gone out.",
      );
    }
    throw error;
  }
  try {
    await sendMessage(deps.email, loaded.bot.name, address, mail);
  } catch {
    await deps.prisma.botEmailMessage
      .deleteMany({ where: { botId: loaded.bot.id, key } })
      .catch(() => undefined);
    throw new ClientError("BAD_REQUEST", "Sending failed. It most likely did not go out.");
  }
}

async function sendMessage(
  email: TransactionalEmailProvider,
  botName: string,
  address: string,
  mail: ReturnType<typeof emailReplyOutbound>,
) {
  const name = botName.replace(/["\\\r\n]/g, "");
  await email.send({
    from: `"${name}" <${address}>`,
    replyTo: address,
    to: mail.to,
    ...(mail.cc.length ? { cc: mail.cc } : {}),
    subject: mail.subject,
    text: mail.body,
  });
}

async function storeBlock(
  deps: Pick<RouterDeps, "prisma" | "events">,
  loaded: Awaited<ReturnType<typeof loadDraft>>,
  block: ReturnType<typeof emailReplyBlock>,
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${loaded.message.threadId} FOR UPDATE`;
    const message = await tx.message.findFirst({
      where: { id: loaded.message.id, threadId: loaded.message.threadId },
    });
    if (!message) throw new ClientError("NOT_FOUND", "That draft is not in this chat");
    const next = changeMessageBlocks(message, (entry) =>
      entry.kind === "email_reply" && entry.draftId === block.draftId ? block : entry,
    );
    if (!next) return { block, seq: null as number | null };
    await tx.message.update({ where: { id: message.id }, data: { blocks: next.stored } });
    const event = await appendEventInTransaction(tx, {
      spaceId: loaded.bot.spaceId,
      threadId: message.threadId,
      botId: loaded.bot.id,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: message.role, blocks: next.blocks },
    });
    return { block, seq: event.seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (committed.seq !== null) {
    await deps.events.notify(loaded.message.threadId, committed.seq).catch(() => undefined);
  }
  return committed.block;
}
