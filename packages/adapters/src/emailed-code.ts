import { createHash } from "node:crypto";
import type {
  AdapterContext,
  BrowserProvider,
  ComputerRef,
  ConnectedMailSource,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { readOneTimeCode } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, isMessagingChannelRun, PUBLIC_MAILBOX_DOMAINS } from "@rakazo/core";
import { hostSite } from "@rakazo/core/egress";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  findPendingAsk,
  recordAuditEvent,
  runAsSystemInTransaction,
  teamChatRunFromOwner,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { connectedContext, selectRunConnections } from "./connection-context.js";
import { readInboundEmail } from "./inbound-email.js";

/** How long before a code request an email may have arrived and still answer it. */
export const EMAILED_CODE_WINDOW_MS = 5 * 60 * 1000;
/** The earliest an email may have arrived to answer a code request: in its run, shortly before. */
export function emailedCodeWindowStart(requestedAt: Date, runStartedAt: Date): Date {
  const beforeRequest = requestedAt.getTime() - EMAILED_CODE_WINDOW_MS;
  return new Date(Math.max(beforeRequest, runStartedAt.getTime()));
}
/** Emails read from the inbox per query while looking for the site's: its sender is encrypted. */
const EMAIL_BATCH = 50;
/**
 * The most emails from the site in the window compared for one lookup, the inbox's daily limit for
 * unsolicited mail; past it there is no code. Mail from other senders is not counted, so it never
 * hides the site's email.
 */
export const EMAIL_SEARCH_LIMIT = 500;
/**
 * The most emails in all read for one lookup: an open card's window keeps growing, and each email
 * arriving looks again. Past it there is no code, and the card stays for the owner.
 */
export const EMAIL_READ_LIMIT = 5_000;

/**
 * Whether a run may read its bot's inbox: the owner's own run, never another bot's message, a
 * group, or a chat that reaches people besides the owner.
 */
export function readsBotInbox(input: {
  run: { userId: string; trigger: string };
  bot: { userId: string };
  thread: { groupId: string | null };
  nonOwnerChatRun: boolean;
}): boolean {
  return (
    input.run.userId === input.bot.userId &&
    input.run.trigger !== "bot_message" &&
    !input.thread.groupId &&
    !input.nonOwnerChatRun
  );
}

/**
 * A run started from a messaging channel, or from team chat by anyone the owner did not link to
 * themselves: either reaches people besides the owner.
 */
export async function isNonOwnerChatRun(
  prisma: PrismaClient,
  input: {
    trigger: string;
    sourceBlocks: MessageBlock[] | undefined;
    sourceClientNonce: string | null | undefined;
    externalConversationId: string | null;
  },
): Promise<boolean> {
  if (isMessagingChannelRun(input.trigger, input.sourceBlocks)) return true;
  if (input.trigger !== "messaging" || !input.externalConversationId) return false;
  return !(await teamChatRunFromOwner(prisma, {
    externalConversationId: input.externalConversationId,
    sourceClientNonce: input.sourceClientNonce,
  }));
}

/**
 * Records of the inbox's codes, kept as effects of the run that took them: `idempotencyKey` is
 * unique, so inserting one is the claim, and two runs (or a run and the inbox) never both get it.
 * Their status is none a tool's effect has, so nothing replays or reads them as tool calls.
 */
const EMAILED_CODE_EFFECT = "emailed_code";
/**
 * The claim on an email is on the message, by its key (InboundEmail.key): the signature its
 * sender's domain made, which every copy of the message carries. So one message has one claim,
 * whichever mailbox a look reads it from: the bot's inbox, also after its row was deleted and the
 * message delivered again (a relay's retry, the bot's delete_email), or a mailbox the owner
 * connected, through any connection to it.
 */
const messageClaimKey = (key: string) =>
  `emailed-code:message:${createHash("sha256").update(key).digest("base64url")}`;
const runSiteClaimKey = (runId: string, site: string) => `emailed-code:run:${runId}:${site}`;
const pageSeenKey = (requestId: string) => `emailed-code:page:${requestId}`;
/**
 * The most messages from the site read from a connected mailbox for one lookup (past it there is
 * no code), and how long the read may take. As for the inbox, the limit is on the site's mail: the
 * provider's search is loose, so mail from other senders is read past, page after page, and never
 * hides the site's email.
 */
export const CONNECTED_MAIL_LIMIT = 5;
export const CONNECTED_MAIL_TIMEOUT_MS = 3000;
/** The most pages of one mailbox's search read: past them the card opens. */
export const CONNECTED_MAIL_PAGE_LIMIT = 10;
/**
 * The most mail one lookup reads from the mailboxes the owner connected, in bytes, in all: a
 * sign-in code's email is a few tens of kilobytes. Past it the card opens: what was left unread
 * may be the newest from the site.
 */
export const CONNECTED_MAIL_MAX_BYTES = 2 * 1024 * 1024;
/** The most open code requests of one owner compared when a code is taken: past it, the card. */
export const OPEN_CODE_REQUEST_LIMIT = 100;

/**
 * The site a code may be filled for from mail: an HTTPS origin's, unless it is a public mailbox
 * domain, where anyone with an address can send mail signed by the site. For those the card is
 * always the owner's, and no mailbox is read.
 */
function fillableSite(origin: string): string | undefined {
  const url = URL.canParse(origin) ? new URL(origin) : undefined;
  const site = url?.protocol === "https:" ? hostSite(url.hostname) : undefined;
  return site && !publicMailboxDomain(site) ? site : undefined;
}

function publicMailboxDomain(site: string): boolean {
  return PUBLIC_MAILBOX_DOMAINS.some((domain) => hostSite(domain) === site);
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** What delivery tells about an email that decides whether it may give any code at all. */
type MailKind = {
  /** Signed by its From domain and addressed to the mailbox (for the bot's inbox: verified). */
  verified: boolean;
  /** Each null when the mail was saved before this was told apart: then it never gives one. */
  mailingList: boolean | null;
  autoReplyOrBulk: boolean | null;
};

/**
 * Whether an email may give a sign-in code at all, whichever mailbox has it and whichever site
 * asks: verified, and known to be neither list mail nor an auto-reply or bulk mail (any of which
 * can carry what someone else wrote, or went to many people).
 */
export function mayGiveCode(email: MailKind): boolean {
  return email.verified && email.mailingList === false && email.autoReplyOrBulk === false;
}

/** What a look knows of an email, whichever mailbox holds it. */
type Mail = MailKind & {
  fromAddress: string | null | undefined;
  /** When the mailbox received it. */
  receivedAt: Date;
  /** Who it was sent to: read only for a mailbox someone connected. */
  recipients?: string[];
};

/** What a code request asks of an email that answers it. */
type CodeRule = {
  site: string;
  /** The domain this server's bots send mail from. */
  botEmailDomain: string | undefined;
  /** The earliest the email may have arrived (emailedCodeWindowStart). */
  after: Date;
  /** When a secret request was last answered since `after` (lastAnsweredAt), if one was. */
  answered: Date | undefined;
  /** The address of the connected mailbox the email is in; absent for the bot's own inbox. */
  mailbox?: string;
};

/**
 * Whether an email arrived in time to answer a request: in its window, and after the last
 * answered secret request, whose answer may have been the code an older email holds.
 */
function arrivedInTime(receivedAt: Date, rule: Pick<CodeRule, "after" | "answered">): boolean {
  return receivedAt >= rule.after && !(rule.answered && receivedAt <= rule.answered);
}

/**
 * Whether an email may answer a code request, by what the email itself says, from whichever
 * mailbox it was read, on every look: it arrived in time (arrivedInTime), it may give a code at
 * all (mayGiveCode), it is signed by its From domain, which is the site's own (subdomains of a
 * shared hosting suffix are each their own site), not a public mailbox domain, not this server's,
 * and, for a mailbox someone connected, was sent to that mailbox itself. What the database says
 * of it (no run took its code, and the request is its owner's only open one for the site) is
 * decided when the code is taken, by claimEmailedCode.
 */
export function emailMayAnswer(email: Mail, rule: CodeRule): boolean {
  if (!arrivedInTime(email.receivedAt, rule)) return false;
  if (!email.fromAddress || !mayGiveCode(email)) return false;
  const domain = domainOf(email.fromAddress);
  if (domain === rule.botEmailDomain || hostSite(domain) !== rule.site) return false;
  if (publicMailboxDomain(rule.site)) return false;
  if (rule.mailbox === undefined) return true;
  const mailbox = rule.mailbox.toLowerCase();
  // Anyone with an address on the mailbox's own domain can send it mail that domain signs.
  if (hostSite(domainOf(mailbox)) === rule.site) return false;
  return (email.recipients ?? []).some((address) => address.toLowerCase() === mailbox);
}

/** The one code the emails that may answer hold, with the newest of them; none when they differ. */
function theOneCode<T extends { code: string; receivedAt: Date }>(candidates: T[]): T | undefined {
  const [first] = candidates;
  if (!first || candidates.some((candidate) => candidate.code !== first.code)) return undefined;
  return candidates.reduce((newest, one) => (one.receivedAt > newest.receivedAt ? one : newest));
}

/**
 * The runs whose sign-in codes can be in the mail a look for the bot reads: every run of the
 * bot, whose address its sites write to, and every run of its owner `userId`, whose own mailbox
 * the bot may read.
 */
const runsSharingMail = (input: { botId: string; userId: string }) => ({
  OR: [{ botId: input.botId }, { userId: input.userId }],
});

/**
 * When the newest secret request in one of those runs in the Space was answered since `after`:
 * older mail may hold its code, as the owner may have typed it into any of their cards.
 */
async function lastAnsweredAt(
  prisma: PrismaClient,
  input: { botId: string; spaceId: string; after: Date; userId: string },
): Promise<Date | undefined> {
  const answered = await prisma.externalEffect.findFirst({
    where: {
      spaceId: input.spaceId,
      kind: "request_secret",
      status: { not: "intended" },
      updatedAt: { gte: input.after },
      run: runsSharingMail(input),
    },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  return answered?.updatedAt;
}

/**
 * The code for `origin` in the bot's own inbox, if there is exactly one to take. It comes from
 * mail that may answer (emailMayAnswer: signed mail from the site's own domain, received since
 * `after` and since the last answered secret request, that no bot on this server sent), that no
 * run took a code from, and that gives exactly one code (readOneTimeCode). Emails that name no
 * code are skipped; two with different codes give nothing, and neither does any while one of
 * them is unclear: it names a code but gives none to take, so the others' are in doubt.
 * A run takes at most one emailed code per site; after that the owner answers the card.
 * Null when the inbox holds codes from the site but not one to take, or more mail than it reads:
 * no other source may answer then.
 */
export async function findEmailedCode(
  prisma: PrismaClient,
  input: {
    botId: string;
    spaceId: string;
    runId: string;
    /** The bot's owner. */
    userId: string;
    origin: string;
    after: Date;
    /** The domain this server's bots send mail from. */
    botEmailDomain: string | undefined;
  },
): Promise<MailCode | null | undefined> {
  const site = fillableSite(input.origin);
  if (!site) return undefined;
  const filled = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: runSiteClaimKey(input.runId, site) },
    select: { id: true },
  });
  if (filled) return undefined;
  const answered = await lastAnsweredAt(prisma, input);
  const rule = { site, botEmailDomain: input.botEmailDomain, after: input.after, answered };
  // The sender is encrypted, so the whole window (minutes long) is read newest first in batches,
  // without subject or text, each filtered here: the limit is on the site's mail, so mail from
  // other senders, however much, never hides the site's email. The query only narrows what is
  // read: emailMayAnswer decides each email, as it does for every other look.
  const fromSite: { id: string; key: string; receivedAt: Date }[] = [];
  let cursor: string | undefined;
  let read = 0;
  while (true) {
    const emails = await prisma.botEmailMessage.findMany({
      where: {
        botId: input.botId,
        sent: false,
        verified: true,
        mailingList: false,
        autoReplyOrBulk: false,
        receivedAt: { gte: input.after, ...(answered ? { gt: answered } : {}) },
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: EMAIL_BATCH,
      select: {
        id: true,
        key: true,
        fromAddress: true,
        verified: true,
        mailingList: true,
        autoReplyOrBulk: true,
        receivedAt: true,
      },
    });
    for (const email of emails) if (emailMayAnswer(email, rule)) fromSite.push(email);
    // Older mail from the site left unread may hold another code: the card stays instead.
    if (fromSite.length > EMAIL_SEARCH_LIMIT) return null;
    cursor = emails.at(-1)?.id;
    read += emails.length;
    if (emails.length < EMAIL_BATCH) break;
    // Older mail left unread may hold another code from the site: the card stays instead.
    if (read >= EMAIL_READ_LIMIT) return null;
  }
  if (fromSite.length === 0) return undefined;
  const claimOf = (email: { key: string }) => messageClaimKey(email.key);
  const claimed = new Set(
    (
      await prisma.externalEffect.findMany({
        where: { idempotencyKey: { in: fromSite.map(claimOf) } },
        select: { idempotencyKey: true },
      })
    ).map((effect) => effect.idempotencyKey),
  );
  const unclaimed = fromSite.filter((email) => !claimed.has(claimOf(email)));
  // Only the mail that may answer is decrypted in full.
  const bodies = new Map(
    unclaimed.length === 0
      ? []
      : (
          await prisma.botEmailMessage.findMany({
            where: { botId: input.botId, id: { in: unclaimed.map((email) => email.id) } },
            select: { id: true, subject: true, text: true },
          })
        ).map((email) => [email.id, email]),
  );
  const candidates: (Omit<MailCode, "site"> & { emailId: string })[] = [];
  for (const { id: emailId, key, receivedAt } of unclaimed) {
    const body = bodies.get(emailId);
    // One was deleted meanwhile and might have held another code.
    if (!body) return null;
    const { code, unclear } = readOneTimeCode(body);
    // The site's own mail leaves its codes in doubt: the card stays instead.
    if (unclear) return null;
    if (code) candidates.push({ code, emailId, key, receivedAt });
  }
  const newest = theOneCode(candidates);
  return newest ? { ...newest, site } : candidates.length > 0 ? null : undefined;
}

/** The message a code was read from: what taking its code needs to know of it. */
type CodeMessage = {
  site: string;
  /** The message's key (InboundEmail.key), the same for every copy of the message. */
  key: string;
  receivedAt: Date;
  /** The inbox row it was read from, when it came from the bot's own inbox. */
  emailId?: string;
};

/** A code found in mail, with the message it came from. */
type MailCode = CodeMessage & { code: string };

/** What finds a code in the mailboxes the owner connected. */
export type ConnectedMailDeps = {
  prisma: PrismaClient;
  connectedMail: ConnectedMailSource;
  /** The domain this server's bots send mail from. */
  botEmailDomain: string | undefined;
};

/**
 * The code for `origin` in the mailboxes the owner connected in the run's Space, if there is
 * exactly one to take, by the rules of findEmailedCode: from each, the newest few messages from
 * the site's domain in the window, read raw so their signatures can be checked, and only those
 * emailMayAnswer with the mailbox's own address. The whole read is bounded in time and in bytes
 * (CONNECTED_MAIL_MAX_BYTES) and only ever reads. When it fails for any reason, there is no code,
 * and only the error's name is logged.
 */
export async function findConnectedMailCode(
  deps: ConnectedMailDeps,
  input: {
    botId: string;
    spaceId: string;
    runId: string;
    /** The owner, whose connections these are. */
    userId: string;
    origin: string;
    after: Date;
  },
): Promise<MailCode | undefined> {
  const { prisma } = deps;
  const site = fillableSite(input.origin);
  if (!site) return undefined;
  const filled = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: runSiteClaimKey(input.runId, site) },
    select: { id: true },
  });
  if (filled) return undefined;
  // The owner may have turned it off since the attempt began.
  const bot = await prisma.bot.findUnique({
    where: { id: input.botId },
    select: { connectedMailCodes: true, name: true },
  });
  if (!bot?.connectedMailCodes) return undefined;
  const rows = await prisma.connection.findMany({
    where: { userId: input.userId, spaceId: input.spaceId },
    select: {
      id: true,
      connectorId: true,
      provider: true,
      providerRef: true,
      displayName: true,
      status: true,
    },
  });
  const readers = selectRunConnections(rows, []).flatMap((row) => {
    // Each read is scoped to its one connection: the reader can reach no other account.
    const context = connectedContext([row]);
    const connection = context.connectedConnections?.[0];
    const reader = connection && deps.connectedMail.readerFor(connection);
    return reader ? [{ row, context, reader }] : [];
  });
  if (readers.length === 0) return undefined;
  const answered = await lastAnsweredAt(prisma, input);
  const rule = { site, botEmailDomain: deps.botEmailDomain, after: input.after, answered };
  const candidates: { code: string; key: string; receivedAt: Date }[] = [];
  const signal = AbortSignal.timeout(CONNECTED_MAIL_TIMEOUT_MS);
  // What the look may still read, in bytes, from all its mailboxes.
  let left = CONNECTED_MAIL_MAX_BYTES;
  // The connections whose mailbox the look began to read, and how many of them it read through.
  const opened: (typeof rows)[number][] = [];
  let readThrough = 0;
  let failed = false;
  try {
    await bounded(signal, async () => {
      for (const { row, context: connected, reader } of readers) {
        opened.push(row);
        const context: AdapterContext = {
          operationId: `emailed-code:${input.runId}:${row.id}`,
          traceId: input.runId,
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
          signal,
          ...connected,
        };
        signal.throwIfAborted();
        const mailbox = await reader.mailbox(context);
        let fromSite = 0;
        let pages = 0;
        let page: string | undefined;
        do {
          // The look gave up or timed out: read nothing more for it.
          signal.throwIfAborted();
          if (++pages > CONNECTED_MAIL_PAGE_LIMIT) throw new Error("The search has too many pages");
          const read = await reader.recent(context, {
            fromDomain: site,
            // Nothing older than the last answer can answer, so it is not asked for.
            after: answered ?? input.after,
            limit: CONNECTED_MAIL_LIMIT,
            maxBytes: left,
            ...(page ? { page } : {}),
          });
          for (const message of read.messages) {
            signal.throwIfAborted();
            // Held to the look's limit here too, whatever the reader did: nothing past it is
            // parsed. A message that cannot be read or judged may hold the newest code: the whole
            // look fails, so the card opens rather than an older message answering in its place.
            left -= message.raw.byteLength;
            if (left < 0) throw new Error("The mailbox returned more mail than the look may read");
            if (!message.receivedAt) throw new Error("A message's arrival time is not known");
            // Too old to answer: not parsed.
            if (!arrivedInTime(message.receivedAt, rule)) continue;
            const email = await readInboundEmail(message.raw);
            if (email.temporaryFailure) throw new Error("A message's signature cannot be checked");
            const mayAnswer = emailMayAnswer(
              {
                fromAddress: email.from?.address,
                verified: email.authenticated,
                mailingList: email.mailingList,
                autoReplyOrBulk: email.autoReplyOrBulk,
                receivedAt: message.receivedAt,
                recipients: [...email.to, ...email.cc],
              },
              { ...rule, mailbox },
            );
            if (!mayAnswer) continue;
            // An older message from the site left unread may hold another code.
            if (++fromSite > CONNECTED_MAIL_LIMIT)
              throw new Error("The site sent too many messages");
            const { code, unclear } = readOneTimeCode(email);
            // As in the bot's inbox: the site's own mail leaves its codes in doubt.
            if (unclear) throw new Error("A message from the site names a code it does not give");
            if (code) candidates.push({ code, key: email.key, receivedAt: message.receivedAt });
          }
          page = read.next;
        } while (page);
        readThrough += 1;
      }
    });
  } catch (error) {
    failed = true;
    getLogger().warn("connected mail could not be read for a code", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  // The owner's mail was read for this run: who read which mailbox and how it went, never what.
  await Promise.all(
    opened.map((row, index) =>
      recordAuditEvent({
        action: "connected_mail.read_for_code",
        actor: { type: "bot", id: input.botId, label: bot.name },
        spaceId: input.spaceId,
        target: { type: "connection", id: row.id, label: row.displayName },
        outcome: index < readThrough ? "success" : "failure",
        runId: input.runId,
        metadata: { site },
      }),
    ),
  );
  if (failed) return undefined;
  if (candidates.length === 0) return undefined;
  const claimed = new Set(
    (
      await prisma.externalEffect.findMany({
        where: { idempotencyKey: { in: candidates.map((found) => messageClaimKey(found.key)) } },
        select: { idempotencyKey: true },
      })
    ).map((effect) => effect.idempotencyKey),
  );
  const newest = theOneCode(candidates.filter((found) => !claimed.has(messageClaimKey(found.key))));
  return newest && { ...newest, site };
}

/** Run `work` until `signal` times out, whether or not what it waits on honours the signal. */
async function bounded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("timed out"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * The email's code is not this request's to take: another run, or this run for the same site,
 * already took it, or another open request could be the one it is for.
 */
export class EmailedCodeTaken extends Error {}

/**
 * Whether the email could be for another code request: one for the same site that is open
 * (asked and not yet answered, whether or not its card shows yet) in another run still going
 * that shares the mail (runsSharingMail), in any Space, whose window the email arrived in. Mail
 * does not say which sign-in it is for, so while two it could be for are open it answers neither.
 */
async function anotherRequestMayTake(
  tx: Prisma.TransactionClient,
  input: { runId: string; botId: string; userId: string; site: string; receivedAt: Date },
): Promise<boolean> {
  // A run sees only its own Space's runs; the owner's other sign-ins can be in any of theirs.
  const reason = "find a bot owner's other open code requests in every Space";
  const open = await runAsSystemInTransaction(tx, reason, () =>
    tx.externalEffect.findMany({
      where: {
        kind: "request_secret",
        status: "intended",
        runId: { not: input.runId },
        run: { status: { in: [...ACTIVE_RUN_STATUSES] }, ...runsSharingMail(input) },
      },
      select: { request: true, createdAt: true, run: { select: { createdAt: true } } },
      take: OPEN_CODE_REQUEST_LIMIT + 1,
    }),
  );
  // More than are compared: one left out may be for the site.
  if (open.length > OPEN_CODE_REQUEST_LIMIT) return true;
  return open.some((request) => {
    const asked = request.request as { oneTimeCode?: { origin?: unknown } } | null;
    const origin = asked?.oneTimeCode?.origin;
    return (
      typeof origin === "string" &&
      fillableSite(origin) === input.site &&
      emailedCodeWindowStart(request.createdAt, request.run.createdAt) <= input.receivedAt
    );
  });
}

/**
 * Take the email's code for `runId` in `tx`, the transaction that keeps the code, deciding there
 * what only the database knows of the email: throws EmailedCodeTaken, which rolls `tx` back, when
 * another open request could be the one it is for (anotherRequestMayTake), when a run already
 * took the message's code, or when this run took one for the site. So a claim stands only with
 * the kept code, and a code that was kept is offered once: a claim is never given back. Every
 * look takes a code through here, whichever mailbox it read it from.
 */
export async function claimEmailedCode(
  tx: Prisma.TransactionClient,
  input: CodeMessage & {
    runId: string;
    spaceId: string;
    /** The bot, and its owner: the email could be for another sign-in of either's runs. */
    botId: string;
    userId: string;
  },
): Promise<void> {
  if (await anotherRequestMayTake(tx, input)) throw new EmailedCodeTaken();
  const keys = [runSiteClaimKey(input.runId, input.site), messageClaimKey(input.key)];
  const { count } = await tx.externalEffect.createMany({
    data: keys.map((idempotencyKey) => ({
      runId: input.runId,
      spaceId: input.spaceId,
      kind: EMAILED_CODE_EFFECT,
      status: "taken",
      idempotencyKey,
      request: { site: input.site, ...(input.emailId ? { emailId: input.emailId } : {}) },
    })),
    skipDuplicates: true,
  });
  if (count !== keys.length) throw new EmailedCodeTaken();
}

/** Where a request's code may come from: the bot's own inbox, then mail the owner connected. */
export type CodeSources = {
  inbox: boolean;
  /** Set only for a bot whose owner turned on reading their connected mail for codes. */
  connected: ConnectedMailSource | undefined;
};

/** A code found for a request, from whichever source, with the claim that takes it. */
export type FoundCode = {
  code: string;
  site: string;
  /** Names the email the code came from, which the kept code records so it is never reused. */
  fromEmail: string;
  claim: (tx: Prisma.TransactionClient) => Promise<void>;
};

/**
 * The code for a request from its sources in order: the bot's own inbox first, then the mail its
 * owner connected; never both, and at most one per site in a run across both.
 */
export async function findCodeForRequest(
  prisma: PrismaClient,
  input: Parameters<typeof findEmailedCode>[1] & { sources: CodeSources },
): Promise<FoundCode | undefined> {
  const { runId, spaceId, botId, userId } = input;
  const emailed = input.sources.inbox ? await findEmailedCode(prisma, input) : undefined;
  // The inbox holds the site's mail but no one code: the card is the owner's.
  if (emailed === null) return undefined;
  const found =
    emailed ??
    (input.sources.connected &&
      (await findConnectedMailCode(
        { prisma, connectedMail: input.sources.connected, botEmailDomain: input.botEmailDomain },
        input,
      )));
  if (!found) return undefined;
  const { code, ...message } = found;
  return {
    code,
    site: message.site,
    fromEmail: message.emailId ?? messageClaimKey(message.key),
    claim: (tx) => claimEmailedCode(tx, { ...message, runId, spaceId, botId, userId }),
  };
}

/** Whether the run took a code from mail: its claim is made with the kept code, at once. */
export async function runTookEmailedCode(
  prisma: Pick<PrismaClient, "externalEffect">,
  runId: string,
): Promise<boolean> {
  const claim = await prisma.externalEffect.findFirst({
    where: { runId, kind: EMAILED_CODE_EFFECT, status: "taken" },
    select: { id: true },
  });
  return claim !== null;
}

/**
 * Find the code for a request in its sources (findCodeForRequest) and keep it with `keep`, which
 * makes the claim it is given in the transaction that stores the code: nothing when there is no
 * code, or the claim refuses it (claimEmailedCode). When keeping fails, the email stays for the
 * next try.
 */
export async function takeEmailedCode<T>(
  prisma: PrismaClient,
  input: Parameters<typeof findCodeForRequest>[1],
  keep: (
    found: { code: string; fromEmail: string },
    claim: (tx: Prisma.TransactionClient) => Promise<void>,
  ) => Promise<T>,
): Promise<T | undefined> {
  const found = await findCodeForRequest(prisma, input);
  if (!found) return undefined;
  try {
    return await keep({ code: found.code, fromEmail: found.fromEmail }, found.claim);
  } catch (error) {
    if (error instanceof EmailedCodeTaken) return undefined;
    throw error;
  }
}

/**
 * Note that the run's page was on `origin`, as its browser reported, when it asked for the code
 * of request `requestId`. Mail that comes while the card waits answers only such a card.
 */
export async function notePageForEmailedCode(
  prisma: PrismaClient,
  input: { runId: string; spaceId: string; requestId: string; origin: string },
): Promise<void> {
  await prisma.externalEffect.createMany({
    data: [
      {
        runId: input.runId,
        spaceId: input.spaceId,
        kind: EMAILED_CODE_EFFECT,
        status: "page",
        idempotencyKey: pageSeenKey(input.requestId),
        request: { origin: input.origin },
      },
    ],
    skipDuplicates: true,
  });
}

/** The page's origin as the run's browser reports it, when its computer is already running. */
export async function runPageOrigin(ctx: {
  computer: { heldForTakeover: boolean; lazy: { ready: ComputerRef | undefined } };
  providers: { browser: Pick<BrowserProvider, "snapshot"> };
  context: AdapterContext;
}): Promise<string | undefined> {
  const computer = ctx.computer.lazy.ready;
  if (!computer || ctx.computer.heldForTakeover) return undefined;
  try {
    const page = await ctx.providers.browser.snapshot(
      computer,
      { signal: ctx.context.signal },
      ctx.context,
    );
    return !page.error && URL.canParse(page.url) ? new URL(page.url).origin : undefined;
  } catch (error) {
    ctx.context.signal.throwIfAborted();
    getLogger().warn("page origin could not be read for an emailed code", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

/**
 * The code each of the bot's runs waiting on a code card would take now: the owner's own run, on
 * a card for a code (not a login), whose browser was on the card's origin when it asked. With
 * `runId`, only that run, whose look also reads the owner's connected mail.
 */
async function waitingCardCodes(
  deps: {
    prisma: PrismaClient;
    botEmailDomain: string | undefined;
    connectedMail?: ConnectedMailSource;
  },
  bot: { id: string; userId: string },
  runId?: string,
) {
  const runs = await deps.prisma.run.findMany({
    where: {
      botId: bot.id,
      userId: bot.userId,
      status: "waiting_input",
      ...(runId ? { id: runId } : {}),
    },
    select: {
      id: true,
      spaceId: true,
      threadId: true,
      userId: true,
      trigger: true,
      createdAt: true,
      sourceMessage: { select: { blocks: true, clientNonce: true } },
      thread: { select: { groupId: true, externalConversationId: true } },
    },
  });
  const answers: Array<{ run: (typeof runs)[number]; messageId: string; found: FoundCode }> = [];
  for (const run of runs) {
    const nonOwnerChatRun = await isNonOwnerChatRun(deps.prisma, {
      trigger: run.trigger,
      sourceBlocks: run.sourceMessage?.blocks as MessageBlock[] | undefined,
      sourceClientNonce: run.sourceMessage?.clientNonce,
      externalConversationId: run.thread.externalConversationId,
    });
    if (!readsBotInbox({ run, bot, thread: run.thread, nonOwnerChatRun })) continue;
    const pending = await findPendingAsk(deps.prisma, { threadId: run.threadId, runId: run.id });
    const origin = pending?.pendingAsk.oneTimeCode?.origin;
    if (!pending || !origin || pending.pendingAsk.credential) continue;
    const request = await deps.prisma.externalEffect.findFirst({
      where: { runId: run.id, spaceId: run.spaceId, kind: "request_secret", status: "intended" },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    });
    if (!request) continue;
    const page = await deps.prisma.externalEffect.findUnique({
      where: { idempotencyKey: pageSeenKey(request.id) },
      select: { runId: true, request: true },
    });
    if (page?.runId !== run.id || (page.request as { origin?: unknown }).origin !== origin)
      continue;
    const found = await findCodeForRequest(deps.prisma, {
      botId: bot.id,
      spaceId: run.spaceId,
      runId: run.id,
      userId: bot.userId,
      origin,
      after: emailedCodeWindowStart(request.createdAt, run.createdAt),
      botEmailDomain: deps.botEmailDomain,
      // Connected mail is read only for the one run that asks, never on mail arriving.
      sources: { inbox: true, connected: runId ? deps.connectedMail : undefined },
    });
    if (found) answers.push({ run, messageId: pending.messageId, found });
  }
  return answers;
}

/**
 * New mail in a bot's inbox answers the code card its owner's run is waiting on, when the mail
 * holds the one code for the card's site, as the owner would by typing it in; the run then goes
 * on. Only a card whose run's browser was on the card's origin when it asked, and an email
 * claimed for that run, as findEmailedCode and claimEmailedCode decide: while another open code
 * request could be the one the email is for, the claim refuses it and the card stays, so mail
 * two cards wait for answers neither. The card's own answer path settles a race with the owner:
 * whichever comes second finds the card answered and does nothing. With `runId`, only that
 * run's card: the run looks again once it waits, for mail that came while it was saving the card.
 * Returns how many cards it answered.
 */
export async function answerCodeCardsFromInbox(
  deps: {
    prisma: PrismaClient;
    events: Pick<ThreadEvents, "answerRunInput">;
    jobs: Pick<JobPublisher, "enqueue">;
    /** The domain this server's bots send mail from. */
    botEmailDomain: string | undefined;
    /** With `runId` only: the owner's connected mail, when the bot may read it for codes. */
    connectedMail?: ConnectedMailSource;
  },
  bot: { id: string; userId: string },
  runId?: string,
): Promise<number> {
  let count = 0;
  try {
    for (const { run, messageId, found } of await waitingCardCodes(deps, bot, runId)) {
      try {
        const answered = await deps.events.answerRunInput({
          spaceId: run.spaceId,
          threadId: run.threadId,
          runId: run.id,
          messageId,
          answeredByUserId: run.userId,
          answer: found.code,
          fromEmail: found.fromEmail,
          // In the answer's own transaction, so a card that is not answered leaves the email.
          claimEmail: found.claim,
        });
        if (!answered) continue;
        count += 1;
        await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
          // The answered run is durable; reconciliation will repair a missed wake.
          getLogger().error("emailed code continue enqueue", error);
        });
      } catch (error) {
        if (error instanceof EmailedCodeTaken) continue;
        // The card changed under this answer, usually because the owner answered it first.
        getLogger().warn("emailed code did not answer its card", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  } catch (error) {
    // The email is saved either way; the card stays open for the owner. Only what failed is
    // logged, as for every look: never what the mail or the lookup held.
    getLogger().error("emailed code lookup failed", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  return count;
}
