import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { loadLoginPasswordRedactions } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { EmailReplyDraft } from "@rakazo/core";
import {
  ClientError,
  EmailReplyDraftError,
  emailReplyBlock,
  emailReplyDraftFromBlock,
  emailReplyOutbound,
  emailReplySubjectLine,
  emailReplyThreading,
  emailReplyWithStatus,
  redactSecrets,
} from "@rakazo/core";
import {
  appendEventInTransaction,
  changeMessageBlocks,
  isUniqueViolation,
  reserveBotEmailSend,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
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

type EmailReplyBlock = Extract<MessageBlock, { kind: "email_reply" }>;

type Loaded = {
  message: { id: string; threadId: string; role: string };
  block: EmailReplyBlock;
  bot: { id: string; userId: string; name: string; spaceId: string };
  actor: Actor;
};

type SentCopy = { subject: string; body: string; to: string[]; cc: string[] };

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
  deps: Pick<RouterDeps, "prisma" | "email" | "env" | "events" | "secrets">,
  actor: Actor,
  input: CommitInput,
) {
  const loaded = await loadDraft(deps, actor, input);
  if (loaded.bot.userId !== actor.userId) {
    throw new ClientError("FORBIDDEN", "Only the bot's owner can change this email.");
  }
  if (input.action.type === "discard") {
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
  if (input.action.type === "save") return storeBlock(deps, loaded, emailReplyBlock(draft));

  const current = await readDraft(deps, loaded);
  if (current.status === "sent") return current;
  if (current.status === "discarded") {
    throw new ClientError("CONFLICT", "This draft was discarded.");
  }
  const copy = await dispatch(deps, loaded, draft);
  if (!copy) return loaded.block;
  return storeBlock(
    deps,
    loaded,
    emailReplyBlock(
      emailReplyWithStatus(
        {
          ...draft,
          subject: copy.subject,
          body: copy.body,
          toText: copy.to.join(", "),
          ccText: copy.cc.join(", "),
        },
        "sent",
      ),
    ),
  );
}

async function loadDraft(
  deps: Pick<RouterDeps, "prisma">,
  actor: Actor,
  input: CommitInput,
): Promise<Loaded> {
  const message = await deps.prisma.message.findFirst({
    where: { id: input.messageId, threadId: input.threadId },
  });
  if (!message?.botId) throw new ClientError("NOT_FOUND", "That draft is not in this chat");
  const block = storedMessageBlocks(message).find(
    (entry) => entry.kind === "email_reply" && entry.draftId === input.draftId,
  );
  if (block?.kind !== "email_reply") {
    throw new ClientError("NOT_FOUND", "That draft is not in this chat");
  }
  const bot = await deps.prisma.bot.findFirst({
    where: { id: message.botId, spaceId: actor.spaceId },
    select: { id: true, userId: true, name: true, spaceId: true },
  });
  if (!bot) throw new ClientError("NOT_FOUND", "That draft is not in this chat");
  return { message, block, bot, actor };
}

/** The draft as stored now, under the thread lock, so a send does not start after it was finished. */
async function readDraft(
  deps: Pick<RouterDeps, "prisma">,
  loaded: Loaded,
): Promise<EmailReplyBlock> {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${loaded.message.threadId} FOR UPDATE`;
    const message = await tx.message.findFirst({
      where: { id: loaded.message.id, threadId: loaded.message.threadId },
    });
    const block = message
      ? storedMessageBlocks(message).find(
          (entry) => entry.kind === "email_reply" && entry.draftId === loaded.block.draftId,
        )
      : undefined;
    if (block?.kind !== "email_reply") {
      throw new ClientError("NOT_FOUND", "That draft is not in this chat");
    }
    return block;
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
}

/** Sends the draft, or reports a send already recorded for it. Null means another send is in flight. */
async function dispatch(
  deps: Pick<RouterDeps, "prisma" | "email" | "env" | "secrets">,
  loaded: Loaded,
  draft: EmailReplyDraft,
): Promise<SentCopy | null> {
  let mail: ReturnType<typeof emailReplyOutbound>;
  try {
    mail = emailReplyOutbound(draft);
  } catch (error) {
    if (error instanceof EmailReplyDraftError) throw new ClientError("BAD_REQUEST", error.message);
    throw error;
  }
  const domain = deps.env.inboundEmailDomain;
  if (!deps.email || !domain) {
    throw new ClientError("SERVICE_UNAVAILABLE", "This server can't send email.");
  }
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
  const secrets = await loadLoginPasswordRedactions(deps.prisma, deps.secrets, {
    userId: loaded.bot.userId,
    spaceId: loaded.bot.spaceId,
  });
  const lowered = secrets.map((secret) => secret.toLowerCase());
  if (
    [...mail.to, ...mail.cc].some(
      (recipient) => redactSecrets(recipient.toLowerCase(), lowered) !== recipient.toLowerCase(),
    )
  ) {
    throw new ClientError("BAD_REQUEST", "A recipient's address contains a secret. Don't send it.");
  }
  const subject = emailReplySubjectLine(redactSecrets(mail.subject, secrets));
  const body = redactSecrets(mail.body, secrets);
  if (!subject) throw new ClientError("BAD_REQUEST", "Add a subject");
  if (!body.trim()) throw new ClientError("BAD_REQUEST", "Write the message");

  const parent = mail.inReplyTo
    ? await deps.prisma.botEmailMessage.findFirst({
        where: { id: mail.inReplyTo, botId: loaded.bot.id },
        select: {
          messageId: true,
          references: true,
          fromAddress: true,
          verified: true,
          sent: true,
          receivedAt: true,
        },
      })
    : null;
  const threading = emailReplyThreading(parent, domain);
  const key = `card:${loaded.message.id}:${mail.draftId}`;
  const earlier = await deps.prisma.botEmailMessage.findUnique({
    where: { botId_key: { botId: loaded.bot.id, key } },
    select: { subject: true, text: true, to: true, cc: true },
  });
  // A row is the send we already committed to. Do not reserve or send again, and do not
  // leave the draft ready.
  if (earlier)
    return { subject: earlier.subject, body: earlier.text, to: earlier.to, cc: earlier.cc };

  try {
    await deps.prisma.botEmailMessage.create({
      data: {
        spaceId: loaded.bot.spaceId,
        botId: loaded.bot.id,
        key,
        references: parent ? referenceList(parent) : [],
        fromAddress: address,
        fromName: loaded.bot.name,
        verified: true,
        sent: true,
        to: mail.to,
        cc: mail.cc,
        subject,
        text: body,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
  let reserved: Awaited<ReturnType<typeof reserveBotEmailSend>>;
  try {
    reserved = await reserveBotEmailSend(deps.prisma, {
      userId: loaded.bot.userId,
      botId: loaded.bot.id,
      recipients: [...mail.to, ...mail.cc],
      verifiedReplySender: threading.verifiedReplySender,
    });
  } catch (error) {
    await bestEffort(
      "remove an email reply that was not reserved",
      deps.prisma.botEmailMessage.deleteMany({ where: { botId: loaded.bot.id, key } }),
    );
    throw error;
  }
  if (typeof reserved === "string") {
    await bestEffort(
      "remove an email reply the allowance refused",
      deps.prisma.botEmailMessage.deleteMany({ where: { botId: loaded.bot.id, key } }),
    );
    throw new ClientError("BAD_REQUEST", ALLOWANCE[reserved]);
  }
  try {
    await sendMessage(
      deps.email,
      loaded.bot.name,
      address,
      { ...mail, subject, body },
      threading.headers,
    );
  } catch (error) {
    await bestEffort(
      "remove an email reply that was not accepted",
      deps.prisma.botEmailMessage.deleteMany({ where: { botId: loaded.bot.id, key } }),
    );
    throw error;
  }
  return { subject, body, to: mail.to, cc: mail.cc };
}

function referenceList(parent: { messageId: string | null; references: string[] }): string[] {
  return parent.messageId ? [...parent.references, parent.messageId].slice(-20) : parent.references;
}

async function sendMessage(
  email: TransactionalEmailProvider,
  botName: string,
  address: string,
  mail: { to: string[]; cc: string[]; subject: string; body: string },
  headers: Record<string, string> | undefined,
) {
  const name = botName.replace(/["\\\r\n]/g, "");
  await email.send({
    from: `"${name}" <${address}>`,
    replyTo: address,
    to: mail.to,
    ...(mail.cc.length ? { cc: mail.cc } : {}),
    subject: mail.subject,
    text: mail.body,
    ...(headers ? { headers } : {}),
  });
}

async function storeBlock(
  deps: Pick<RouterDeps, "prisma" | "events">,
  loaded: Loaded,
  block: ReturnType<typeof emailReplyBlock>,
) {
  const committed = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM threads WHERE id = ${loaded.message.threadId} FOR UPDATE`;
    const message = await tx.message.findFirst({
      where: { id: loaded.message.id, threadId: loaded.message.threadId },
    });
    if (!message) throw new ClientError("NOT_FOUND", "That draft is not in this chat");
    const current = storedMessageBlocks(message).find(
      (entry) => entry.kind === "email_reply" && entry.draftId === block.draftId,
    );
    if (current?.kind === "email_reply") {
      if (current.status === "sent" && block.status === "sent") {
        return { block: current, seq: null };
      }
      if (current.status === "sent") {
        throw new ClientError("CONFLICT", "This email was already sent.");
      }
      if (block.status === "ready" && current.status !== "ready") {
        throw new ClientError("CONFLICT", "This draft is no longer editable.");
      }
    }
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
    await bestEffort(
      "notify the thread that an email draft changed",
      deps.events.notify(loaded.message.threadId, committed.seq),
    );
  }
  return committed.block;
}
