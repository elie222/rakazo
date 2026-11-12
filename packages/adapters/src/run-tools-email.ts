import { setTimeout as sleep } from "node:timers/promises";
import {
  BOT_EMAIL_NAME_TAKEN,
  BotEmailNameSchema,
  BotEmailRecipientSchema,
  hideOneTimeCodeInEmail,
  REDACTED_MARK,
} from "@rakazo/contracts";
import { attachmentComputerPath, matchesSearchQuery, redactSecrets } from "@rakazo/core";
import {
  claimBotEmailName,
  reserveBotEmailSend,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { z } from "zod";
import { RunCodeUnreadableError } from "./bot-secrets.js";
import { maskPayload, redactConnectorPayload } from "./connector-safety.js";
import { INBOX_SEARCHED_FIELDS, inboxMailHolding, readsBotInbox } from "./emailed-code.js";
import type { RunContext } from "./run-context.js";
import { hideRunEmailedCodes, isRunTainted, refuseOwnerSettingsChange } from "./run-context.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { argsError } from "./tool-args.js";

/** Longest a read_email call waits for mail to arrive, well inside a run's lease renewal. */
export const READ_EMAIL_MAX_WAIT_SECONDS = 120;
/** Body text one read returns; a longer email continues from nextTextOffset. */
const TEXT_PAGE_CHARS = 8_000;
const PREVIEW_CHARS = 160;
const POLL_MS = 3_000;
/** Emails one delete_email call removes. */
const DELETE_EMAIL_MAX_IDS = 50;
/** Emails a search fetches to check once decrypted, as blind-index matches can be false. */
const SEARCH_CANDIDATES = 100;
/** Emails a search in a run holding a code from an email reads, at most, to check them itself. */
const SEARCH_HIDDEN_EMAILS = 1_000;
/** Times one look is made again because the run took a code from mail while it looked. */
const LOOK_AGAIN_LIMIT = 3;
/**
 * How far before the newest email a look read the next look of the same wait starts. An email is
 * stamped when the insert saving it starts and shows up once that commits, so under load it can
 * show up after mail stamped later. That lag is one insert's; this allows far more: the limit
 * this server sets on its thread transactions (THREAD_LOCK_TRANSACTION_OPTIONS), plus a poll.
 */
const LATE_SAVE_MS = THREAD_LOCK_TRANSACTION_OPTIONS.timeout + POLL_MS;
/**
 * What the inbox itself writes about an email. Every other field the tool returns is the sender's
 * and is masked; masking these could only hint at a hidden value's characters.
 */
const INBOX_FIELDS = new Set(["id", "receivedAt"]);

const ReadEmailSchema = z
  .object({
    id: z.string().trim().min(1).max(100).optional(),
    query: z.string().trim().max(200).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    waitSeconds: z.number().int().min(0).max(READ_EMAIL_MAX_WAIT_SECONDS).optional(),
    textOffset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const DeleteEmailSchema = z
  .object({
    ids: z.array(z.string().trim().min(1).max(100)).min(1).max(DELETE_EMAIL_MAX_IDS),
  })
  .strict();

function sender(email: { fromName: string; fromAddress: string }): string {
  return email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress;
}

type SavedFile = { name: string; artifactId?: string; mimeType?: string; size?: number };

/** While a code the run took from mail cannot be read, no email is shown: any could hold it. */
async function readEmail(ctx: RunContext, call: ToolCall) {
  try {
    return await readInbox(ctx, call);
  } catch (error) {
    if (!(error instanceof RunCodeUnreadableError)) throw error;
    return call.finish({ error: "The inbox cannot be read right now. Try again in a minute." });
  }
}

async function readInbox(ctx: RunContext, call: ToolCall) {
  const parsed = ReadEmailSchema.safeParse(call.args);
  if (!parsed.success) {
    return call.finish({ error: argsError(parsed.error) });
  }
  const input = parsed.data;
  const { deps, bot, run } = ctx;
  // The inbox is the owner's mail: only their own runs of their own bot read it.
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });
  // A code the run took from mail is hidden in every email also with any separators between its
  // characters (hideOneTimeCodeInEmail), whatever else the run hides; its claim says it took one.
  // Which codes those are is asked as each result is produced, never once for the call: the run
  // can take one while the call waits.
  let emailedCodes: string[] = [];
  /** Asks which codes the run holds from mail now; whether they are the ones it last held. */
  const sameCodes = async () => {
    const before = emailedCodes;
    emailedCodes = (await hideRunEmailedCodes(ctx)).sort();
    return before.join("\n") === emailedCodes.join("\n");
  };
  const hide = (value: string) =>
    emailedCodes.reduce(hideOneTimeCodeInEmail, redactSecrets(value, ctx.secrets));
  /**
   * For matching a search: the pieces between what is hidden, each on its own, so neither the word
   * standing in for it nor the text either side of it joined up ever matches.
   */
  const searchable = (value: string) => hide(value).split(REDACTED_MARK);
  /** An email as the tool returns it, hidden as a whole, so no field of it can be missed. */
  const shown = (email: Record<string, unknown>) =>
    redactConnectorPayload(
      Object.fromEntries(
        Object.entries(email).map(([key, value]) => [
          key,
          INBOX_FIELDS.has(key) ? value : maskPayload(value, hide),
        ]),
      ),
      ctx.secrets,
    );

  if (input.id) {
    const email = await deps.prisma.botEmailMessage.findFirst({
      where: { id: input.id, botId: bot.id },
    });
    if (!email) return call.finish({ error: "No email with that id in your inbox." });
    // Asked once the email is read: nothing is awaited from here until the result is built.
    await sameCodes();
    const offset = input.textOffset ?? 0;
    // Masked whole before paging, so a secret split across two pages is still caught.
    const body = hide(email.text);
    const text = body.slice(offset, offset + TEXT_PAGE_CHARS);
    // A file can hold the code as the text does, and nothing hides it in there: while the run
    // holds an emailed code, every email's files stay out of its reach, as any could hold it.
    const files = (email.attachments as SavedFile[]).map((file) =>
      emailedCodes.length ? { name: file.name } : file,
    );
    const kept = files.flatMap((file) =>
      file.artifactId && file.mimeType
        ? [
            {
              kind: "file" as const,
              artifactId: file.artifactId,
              name: file.name,
              mimeType: file.mimeType,
              size: file.size ?? 0,
            },
          ]
        : [],
    );
    // Copied before the bot's next computer tool, where history tools put files too.
    if (kept.length) ctx.computer.copyEarlierFiles(kept);
    // A service can echo a password or code the bot holds as a secret.
    return call.finish({
      untrusted: true,
      email: shown({
        id: email.id,
        from: sender(email),
        ...(email.sent ? { sent: true } : { verified: email.verified }),
        to: email.to,
        ...(email.cc.length ? { cc: email.cc } : {}),
        subject: email.subject,
        receivedAt: email.receivedAt.toISOString(),
        text,
        ...(offset + TEXT_PAGE_CHARS < body.length
          ? { nextTextOffset: offset + TEXT_PAGE_CHARS }
          : {}),
        ...(files.length
          ? {
              files: files.map((file) =>
                file.artifactId && file.mimeType
                  ? {
                      name: file.name,
                      path: attachmentComputerPath(file.artifactId, file.mimeType),
                    }
                  : { name: file.name, unavailable: true },
              ),
            }
          : {}),
      }),
    });
  }

  const startedAt = Date.now();
  const where = {
    botId: bot.id,
    // Waiting is for mail to arrive, so what the bot sent never ends it.
    ...(input.waitSeconds ? { sent: false } : {}),
    ...(input.since || input.before
      ? {
          receivedAt: {
            ...(input.since ? { gt: new Date(input.since) } : {}),
            ...(input.before ? { lt: new Date(input.before) } : {}),
          },
        }
      : {}),
  };
  const limit = input.limit ?? 10;
  // After since: the newest email already looked at, so candidates a search checked and dropped
  // are not checked again by this wait or by a caller following nextSince.
  let checkedTo: Date | undefined;
  const select = {
    id: true,
    fromAddress: true,
    fromName: true,
    verified: true,
    sent: true,
    subject: true,
    receivedAt: true,
    text: true,
    attachments: true,
  } as const;
  // After since, oldest first, so following nextSince reads every new email in order.
  const orderBy = { receivedAt: input.since ? ("asc" as const) : ("desc" as const) };
  const fetchEmails = (args: { where: object; skip?: number; take: number }) =>
    deps.prisma.botEmailMessage.findMany({ ...args, orderBy, select });
  const inWindow = () => ({
    ...where,
    ...(checkedTo ? { receivedAt: { ...where.receivedAt, gt: checkedTo } } : {}),
  });
  /**
   * The database matches stored text, codes and all, so a search there would tell a run holding
   * a code from an email which email holds it, however written. That run reads its mail itself,
   * newest first (oldest first after since), and matches only what it may read, so what it
   * returns and how far it read never depend on the code. Every other run searches the database.
   * A later look of the same wait starts LATE_SAVE_MS before the newest email a look read and
   * leaves out the emails a look already read: mail saved late still turns up, and an email read
   * and dropped, which cannot match then either, is not fetched again. Within a look, mail
   * arriving between pages can push an email onto the next page too; it is skipped there.
   */
  const read = new Map<string, Date>();
  let readNewest: Date | undefined;
  const searchHidden = async (query: string) => {
    const from = readNewest && new Date(readNewest.getTime() - LATE_SAVE_MS);
    const after = input.since ? new Date(input.since) : undefined;
    const window = from
      ? {
          ...where,
          receivedAt: { ...where.receivedAt, gt: after && after > from ? after : from },
          id: { notIn: [...read].flatMap(([id, at]) => (at > from ? [id] : [])) },
        }
      : where;
    const matches: Awaited<ReturnType<typeof fetchEmails>> = [];
    for (
      let skip = 0;
      skip < SEARCH_HIDDEN_EMAILS && matches.length < limit;
      skip += SEARCH_CANDIDATES
    ) {
      const page = await fetchEmails({ where: window, skip, take: SEARCH_CANDIDATES });
      for (const email of page) {
        if (matches.length >= limit) break;
        if (read.has(email.id)) continue;
        read.set(email.id, email.receivedAt);
        if (!readNewest || email.receivedAt > readNewest) readNewest = email.receivedAt;
        if (
          matchesSearchQuery(
            query,
            ...INBOX_SEARCHED_FIELDS.flatMap((field) => searchable(email[field])),
          )
        )
          matches.push(email);
      }
      if (page.length < SEARCH_CANDIDATES) break;
    }
    if (input.since) checkedTo = readNewest ?? checkedTo;
    return matches;
  };
  // Asked again on every look: a Space's first key can appear while the bot waits.
  const list = async () => {
    if (input.query && emailedCodes.length) return searchHidden(input.query);
    const search = input.query
      ? await inboxMailHolding(deps.prisma, bot.spaceId, input.query, INBOX_SEARCHED_FIELDS)
      : undefined;
    const found = await fetchEmails({
      where: { ...inWindow(), ...search?.where },
      take: search?.check ? SEARCH_CANDIDATES : limit,
    });
    if (!search?.check) return found;
    const matches = found.filter((email) =>
      matchesSearchQuery(input.query!, ...INBOX_SEARCHED_FIELDS.map((field) => email[field])),
    );
    if (input.since)
      checkedTo =
        (matches.length >= limit ? matches[limit - 1] : found.at(-1))?.receivedAt ?? checkedTo;
    return matches.slice(0, limit);
  };
  /**
   * One look, made with the codes the run holds from mail as it starts and kept only when it
   * holds the same ones as it ends. When it took one meanwhile, what the look found was matched
   * without that code: it is dropped and the look is made again. Whenever the codes are not the
   * ones the looks so far were made with, how far those read is forgotten, so the call goes on
   * as one that began holding them would. Past LOOK_AGAIN_LIMIT no email is shown.
   */
  const look = async () => {
    let dropped = false;
    for (let again = 0; ; again++) {
      if (!(await sameCodes()) || dropped) {
        checkedTo = undefined;
        readNewest = undefined;
        read.clear();
      }
      const found = await list();
      dropped = !(await sameCodes());
      if (!dropped) return found;
      if (again >= LOOK_AGAIN_LIMIT) throw new RunCodeUnreadableError();
    }
  };
  let emails = await look();
  const deadline = startedAt + (input.waitSeconds ?? 0) * 1000;
  // The last look lands on the deadline, so a wait shorter than one poll still waits.
  for (
    let left = deadline - Date.now();
    emails.length === 0 && left > 0;
    left = deadline - Date.now()
  ) {
    await sleep(Math.min(POLL_MS, left), undefined, { signal: ctx.context.signal });
    emails = await look();
  }
  // Where the next look starts, on the inbox's own clock: the newest email shown here, or the
  // caller's since when nothing new arrived.
  const newest = input.since ? emails.at(-1) : emails[0];
  const nextSince = (checkedTo ?? newest?.receivedAt)?.toISOString() ?? input.since;
  const listed = emails.map((email) => ({
    id: email.id,
    from: sender(email),
    ...(email.sent ? { sent: true } : { verified: email.verified }),
    subject: email.subject,
    receivedAt: email.receivedAt.toISOString(),
    preview: hide(email.text).slice(0, PREVIEW_CHARS).replace(/\s+/g, " ").trim(),
    ...((email.attachments as SavedFile[]).length
      ? { files: (email.attachments as SavedFile[]).length }
      : {}),
  }));
  return call.finish({
    untrusted: true,
    ...(nextSince ? { nextSince } : {}),
    emails: listed.map(shown),
  });
}

async function deleteEmail(ctx: RunContext, call: ToolCall) {
  const parsed = DeleteEmailSchema.safeParse(call.args);
  if (!parsed.success) {
    return call.finish({ error: argsError(parsed.error) });
  }
  const { deps, bot, run } = ctx;
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });
  // Only mail it received: the bot's own sent mail stays as its record of what went out.
  const { count } = await deps.prisma.botEmailMessage.deleteMany({
    where: { id: { in: [...new Set(parsed.data.ids)] }, botId: bot.id, sent: false },
  });
  return call.finish({ deleted: count });
}

/** The owner gives the bot its permanent address from chat. */
async function claimEmailAddress(ctx: RunContext, call: ToolCall) {
  const { deps, bot, run } = ctx;
  const domain = deps.inboundEmailDomain;
  if (!domain) return call.finish({ error: "This server doesn't receive email." });
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });
  // Permanent: without the owner's own approval of this call, text the bot read cannot pick it.
  if (call.nextApprovedTool !== "claim_email_address" && (await isRunTainted(ctx))) {
    return call.finish(
      refuseOwnerSettingsChange(
        ctx,
        "An email address can't be claimed in this run because it read outside content. Ask your owner to request it again.",
      ),
    );
  }
  const parsed = BotEmailNameSchema.safeParse(call.args.name);
  if (!parsed.success) {
    return call.finish({ error: parsed.error.issues[0]?.message ?? "Choose another name." });
  }
  const result = await claimBotEmailName(deps.prisma, bot.id, parsed.data);
  if (result === "taken")
    return call.finish({ error: `${BOT_EMAIL_NAME_TAKEN}. Ask for another.` });
  if (result === "has-another") {
    const current = await deps.prisma.botEmailAddress.findUnique({
      where: { botId: bot.id },
      select: { name: true },
    });
    return call.finish({
      error: "You already have an address, and it can't change.",
      address: current ? `${current.name}@${domain}` : undefined,
    });
  }
  // The run began before this address existed, so its code requests would otherwise skip the
  // inbox that now holds the sign-up mail. Claiming is offered only in the owner's own chat,
  // where readsBotInbox is true.
  ctx.source.emailInbox = readsBotInbox({
    run: ctx.run,
    bot: ctx.bot,
    thread: ctx.thread,
    nonOwnerChatRun: ctx.source.messagingChannelRun,
  });
  return call.finish({
    address: `${parsed.data}@${domain}`,
    note: "This is your email address now. Give it when you sign up for a site as yourself; every email sent to it is saved to your inbox.",
  });
}

const SEND_RECIPIENTS_MAX = 10;
const SEND_TEXT_MAX_CHARS = 20_000;
const SUBJECT_MAX_CHARS = 500;
const MAX_REFERENCES = 20;

const Recipients = z
  .union([BotEmailRecipientSchema, z.array(BotEmailRecipientSchema)])
  .transform((value) => (Array.isArray(value) ? value : [value]));
const SendEmailSchema = z
  .object({
    to: Recipients.refine((list) => list.length > 0, "Name at least one recipient."),
    cc: Recipients.optional(),
    subject: z.string().trim().max(SUBJECT_MAX_CHARS).optional(),
    text: z.string().trim().min(1).max(SEND_TEXT_MAX_CHARS),
    inReplyTo: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

/** Email from the bot's own address; replies come back to its inbox. */
async function sendEmail(ctx: RunContext, call: ToolCall) {
  const { deps, bot, run } = ctx;
  const domain = deps.inboundEmailDomain;
  if (!deps.email || !domain) return call.finish({ error: "This server can't send email." });
  if (run.userId !== bot.userId) return call.finish({ error: "Only the bot's owner can do that." });
  const parsed = SendEmailSchema.safeParse(call.args);
  if (!parsed.success) return call.finish({ error: argsError(parsed.error) });
  const input = parsed.data;
  const cc = input.cc ?? [];
  if (input.to.length + cc.length > SEND_RECIPIENTS_MAX) {
    return call.finish({ error: `Send to at most ${SEND_RECIPIENTS_MAX} people at once.` });
  }
  // An address can carry a secret out as surely as the body, and can't be redacted into another.
  // Compared lowercased, so a change of case can't slip a secret past.
  const secrets = ctx.secrets.map((secret) => secret.toLowerCase());
  if (
    [...input.to, ...cc].some(
      (address) => redactSecrets(address.toLowerCase(), secrets) !== address.toLowerCase(),
    )
  ) {
    return call.finish({ error: "A recipient's address contains a secret. Don't send it." });
  }
  const name = await deps.prisma.botEmailAddress.findUnique({
    where: { botId: bot.id },
    select: { name: true },
  });
  if (!name) return call.finish({ error: "You don't have an email address yet." });
  const address = `${name.name}@${domain}`;

  const original = input.inReplyTo
    ? await deps.prisma.botEmailMessage.findFirst({
        where: { id: input.inReplyTo, botId: bot.id },
        select: {
          subject: true,
          messageId: true,
          references: true,
          fromAddress: true,
          verified: true,
          sent: true,
          receivedAt: true,
        },
      })
    : null;
  if (input.inReplyTo && !original) {
    return call.finish({ error: "No email with that id in your inbox." });
  }
  // Redacted before lines are joined, so a secret that spans lines still matches.
  const subject = redactSecrets(
    input.subject ||
      (original
        ? /^re:/i.test(original.subject)
          ? original.subject
          : `Re: ${original.subject}`
        : ""),
    ctx.secrets,
  )
    .replace(/[\r\n]+/g, " ")
    .slice(0, SUBJECT_MAX_CHARS);
  if (!subject) return call.finish({ error: "Give the email a subject." });
  // Secrets this run has used never leave in an email, whatever the bot was asked to write.
  const text = redactSecrets(input.text, ctx.secrets);
  if (text.length > SEND_TEXT_MAX_CHARS) {
    return call.finish({ error: "The email is too long once secrets are removed. Shorten it." });
  }
  // A reply to mail the bot sent answers what that one answered: its own ID is the provider's.
  const parent = original?.messageId ?? original?.references.at(-1);
  const references = original?.messageId
    ? [...original.references, original.messageId].slice(-MAX_REFERENCES)
    : (original?.references ?? []);

  const key = `sent:${call.effectKey}`;
  // Only what the bot chose: a reply's subject repeats what the sender wrote, outside text that
  // this result, counted as the bot's own, must not carry.
  const done = (id: string) =>
    call.finish({ sent: true, id, from: address, to: input.to, ...(cc.length ? { cc } : {}) });
  const earlier = await deps.prisma.botEmailMessage.findUnique({
    where: { botId_key: { botId: bot.id, key } },
    select: { id: true },
  });
  // A finished send is replayed by the gate, so a row found here is an attempt cut off midway.
  if (earlier) {
    return call.finish({
      error:
        "An earlier attempt to send this email was interrupted and may or may not have gone out. Tell your owner instead of sending it again.",
      id: earlier.id,
    });
  }
  // Only a recent, authenticated incoming message authorizes a reply recipient.
  // A sent copy, forged message, or caller-supplied address can never grant that permission.
  const verifiedReplySender =
    original?.verified &&
    !original.sent &&
    original.receivedAt.getTime() >= Date.now() - 30 * 24 * 60 * 60 * 1000 &&
    original.fromAddress.split("@").at(-1)?.toLowerCase() !== domain.toLowerCase()
      ? original.fromAddress
      : undefined;
  const reserved = await reserveBotEmailSend(deps.prisma, {
    userId: bot.userId,
    botId: bot.id,
    recipients: [...input.to, ...cc],
    verifiedReplySender,
  });
  if (typeof reserved === "string") {
    const errors = {
      limit: "Your account has reached its email allowance for the last 24 hours. Try again later.",
      too_many:
        "This email has more recipients than your account's allowance. Send to fewer recipients.",
      disabled: "Email sending is paused for this account.",
      unverified: "Verify your account email before sending.",
      recipient: "This recipient isn't approved for this account.",
    };
    return call.finish({ error: errors[reserved] });
  }
  // Saved before it goes: a retry after a crash finds it and never sends the email twice.
  const row = await deps.prisma.botEmailMessage.create({
    data: {
      spaceId: bot.spaceId,
      botId: bot.id,
      key,
      references,
      fromAddress: address,
      fromName: bot.name,
      verified: true,
      sent: true,
      to: input.to,
      cc,
      subject,
      text,
    },
    select: { id: true },
  });
  try {
    await deps.email.send({
      from: `"${bot.name.replace(/["\\\r\n]/g, "")}" <${address}>`,
      replyTo: address,
      to: input.to,
      ...(cc.length ? { cc } : {}),
      subject,
      text,
      ...(parent ? { headers: { "In-Reply-To": parent, References: references.join(" ") } } : {}),
    });
  } catch (error) {
    await deps.prisma.botEmailMessage.delete({ where: { id: row.id } }).catch(() => undefined);
    // Most failures are refusals, but one can come after the provider took the email, so the
    // reserved send keeps counting toward the daily limits either way.
    return call.finish({
      error: `Sending failed (${error instanceof Error ? error.message : String(error)}). It most likely did not go out.`,
    });
  }
  return done(row.id);
}

/** The bot's own address and inbox: mail anyone sent to it, and mail it sends. */
export const emailTools: ToolHandlers = {
  read_email: readEmail,
  delete_email: deleteEmail,
  claim_email_address: claimEmailAddress,
  send_email: sendEmail,
};
