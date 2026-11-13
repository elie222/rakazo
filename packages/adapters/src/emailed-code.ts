import { createHash } from "node:crypto";
import type {
  AdapterContext,
  BrowserProvider,
  ComputerRef,
  ConnectedMailListing,
  ConnectedMailSource,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { INBOX_DAILY_LIMIT, readOneTimeCode } from "@rakazo/contracts";
import { isMessagingChannelRun, PUBLIC_MAILBOX_DOMAINS } from "@rakazo/core";
import { hostSite } from "@rakazo/core/egress";
import type { CodeSite, MailSharingRuns, Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  codeAnsweredSince,
  contentEncryptionOf,
  EMAILED_CODE_EFFECT,
  findPendingAsk,
  holdCodeAnswers,
  otherCodeRequestOpen,
  recordAuditEvent,
  teamChatRunFromOwner,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { connectedContext, loadConnectedConnections } from "./connection-context.js";
import { readInboundEmail } from "./inbound-email.js";

/** How long before and after a code request an email may have arrived and still answer it. */
export const EMAILED_CODE_WINDOW_MS = 5 * 60 * 1000;
/** When an email may have arrived to answer a code request: `after` to `before`, both included. */
export type CodeWindow = { after: Date; before: Date };
/**
 * The window of a code request: mail that arrived in its run, from shortly before it asked to
 * shortly after. A sign-in's code comes within minutes of it; mail outside that is not the
 * request's, so the request neither takes it nor keeps another request from it.
 */
export function emailedCodeWindow(requestedAt: Date, runStartedAt: Date): CodeWindow {
  const asked = requestedAt.getTime();
  return {
    after: new Date(Math.max(asked - EMAILED_CODE_WINDOW_MS, runStartedAt.getTime())),
    before: new Date(asked + EMAILED_CODE_WINDOW_MS),
  };
}
/** Emails read from the inbox per query while looking for the site's: its sender is encrypted. */
const EMAIL_BATCH = 50;
/**
 * The most emails from the site in the window compared for one lookup, the inbox's daily limit for
 * unsolicited mail; past it there is no code. Mail from other senders is not counted, so it never
 * hides the site's email.
 */
export const EMAIL_SEARCH_LIMIT = INBOX_DAILY_LIMIT;
/**
 * The most emails in all read for one lookup, as each email arriving in an open card's window
 * looks again. Past it there is no code, and the card stays for the owner. Only mail the query
 * finds to hold the site's name is read (inboxMailHolding), so mail that does not name the site
 * is never counted.
 */
export const EMAIL_READ_LIMIT = 5_000;

/** The fields of an inbox email its sender wrote, which an inbox search looks in. */
export const INBOX_SEARCHED_FIELDS = ["fromAddress", "fromName", "subject", "text"] as const;
type InboxField = (typeof INBOX_SEARCHED_FIELDS)[number];

/**
 * What narrows a query of an inbox to the mail that may hold `text` in one of `fields`, and
 * whether what it finds still has to be checked. Plaintext mail matches `text` inside one of
 * the fields. Encrypted mail matches on blind-index prefix tokens of the words of `text`, which
 * cover all of an email's fields together and can collide: so it never leaves out mail that
 * holds those words, and what it finds is checked against the decrypted fields afterwards
 * (`check`). Text inside a word only matches mail that is still plaintext, as in Space search.
 */
export async function inboxMailHolding(
  prisma: PrismaClient,
  spaceId: string,
  text: string,
  fields: readonly InboxField[],
): Promise<{ where: Prisma.BotEmailMessageWhereInput; check: boolean }> {
  const plaintext = fields.map((field) => ({
    [field]: { contains: text, mode: "insensitive" as const },
  }));
  const encryption = contentEncryptionOf(prisma);
  const keyTokens = encryption ? await encryption.messageSearchTokens(spaceId, text, "prefix") : [];
  // No keys: nothing in the Space was ever encrypted.
  if (!keyTokens.length) return { where: { OR: plaintext }, check: false };
  const tokenSets = keyTokens.filter((tokens) => tokens.length);
  // No term long enough to be indexed: check the newest mail.
  if (!tokenSets.length) return { where: {}, check: true };
  const encrypted = tokenSets.map((tokens) => ({ searchTokens: { hasEvery: tokens } }));
  return { where: { OR: [...encrypted, ...plaintext] }, check: true };
}

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
    input.run.trigger !== "webhook" &&
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
 * sign-in code's email is a few tens of kilobytes. Only mail that may be the site's is read, so
 * only that counts. Past it the card opens: what was left unread may be the newest from the site.
 */
export const CONNECTED_MAIL_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The exact hostname a code may be filled for from mail: standard HTTPS, unless it is a public
 * mailbox domain, where anyone with an address can send mail signed by the site. For those the card is
 * always the owner's, and no mailbox is read.
 */
function fillableSite(origin: string): string | undefined {
  const url = URL.canParse(origin) ? new URL(origin) : undefined;
  // Only the authenticated sender's exact HTTPS authority can receive its code.
  // A parent/sibling domain and a non-default port need the owner's manual card answer.
  const site = url?.protocol === "https:" && !url.port ? url.hostname : undefined;
  return site && !publicMailboxDomain(site) ? site : undefined;
}

function publicMailboxDomain(site: string): boolean {
  return PUBLIC_MAILBOX_DOMAINS.some((domain) => hostSite(domain) === hostSite(site));
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
/** Exact sender authority only; registrable-domain equality does not bind an origin. */
const onSite = (address: string, site: string) => domainOf(address) === site;
/** The site as the code requests of other runs are asked about it (codeAnsweredSince). */
const codeSite = (site: string): CodeSite => ({
  name: hostSite(site) ?? site,
  holds: (origin) => {
    const candidate = fillableSite(origin);
    return candidate !== undefined && hostSite(candidate) === hostSite(site);
  },
});

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

/**
 * What narrows an inbox query to mail whose sender may be on `site`: every address on the site
 * holds the site's name, so asking for mail that holds it leaves none of the site's out. Only
 * for a name written in plain letters, digits, dots and hyphens, which an address on the site
 * writes the same way; for any other (an internationalized name can be written in two ways)
 * nothing is narrowed.
 */
async function mailNaming(
  prisma: PrismaClient,
  spaceId: string,
  site: string,
): Promise<Prisma.BotEmailMessageWhereInput> {
  if (!/^[a-z0-9.-]+$/.test(site) || /(^|\.)xn--/.test(site)) return {};
  return (await inboxMailHolding(prisma, spaceId, site, ["fromAddress"])).where;
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
type CodeRule = CodeWindow & {
  site: string;
  /** The domain this server's bots send mail from. */
  botEmailDomain: string | undefined;
  /** The address of the connected mailbox the email is in; absent for the bot's own inbox. */
  mailbox?: string;
};

/** Whether an email arrived in a request's window (emailedCodeWindow). */
function arrivedIn(window: CodeWindow, receivedAt: Date): boolean {
  return receivedAt >= window.after && receivedAt <= window.before;
}

/**
 * Whether an email may answer a code request, by what the email itself says, from whichever
 * mailbox it was read, on every look: it arrived in the request's window, it may give a code at
 * all (mayGiveCode), it is signed by its From domain, exactly the page's HTTPS hostname,
 * not a public mailbox domain or this server's,
 * and, for a mailbox someone connected, was sent to that mailbox itself. What the database says
 * of it (no run took its code, no code request for the site was answered since it came, and no
 * other open request could take it) is decided when the code is taken, by claimEmailedCode.
 */
export function emailMayAnswer(email: Mail, rule: CodeRule): boolean {
  if (!arrivedIn(rule, email.receivedAt)) return false;
  if (!email.fromAddress || !mayGiveCode(email)) return false;
  const domain = domainOf(email.fromAddress);
  if (domain === rule.botEmailDomain || !onSite(email.fromAddress, rule.site)) return false;
  if (publicMailboxDomain(rule.site)) return false;
  if (rule.mailbox === undefined) return true;
  const mailbox = rule.mailbox.toLowerCase();
  // Anyone with an address on the mailbox's own domain can send it mail that domain signs.
  if (hostSite(domainOf(mailbox)) === hostSite(rule.site)) return false;
  return (email.recipients ?? []).some((address) => address.toLowerCase() === mailbox);
}

/** The one code the emails that may answer hold, with the newest of them; none when they differ. */
function theOneCode<T extends { code: string; receivedAt: Date }>(candidates: T[]): T | undefined {
  const [first] = candidates;
  if (!first || candidates.some((candidate) => candidate.code !== first.code)) return undefined;
  return candidates.reduce((newest, one) => (one.receivedAt > newest.receivedAt ? one : newest));
}

/** What a look for a request's code is given, whichever mailbox it reads. */
type CodeLook = MailSharingRuns & {
  spaceId: string;
  runId: string;
  /** The code request the look is for (its effect's id). */
  requestId: string;
  origin: string;
  /** When mail may have arrived to answer the request (emailedCodeWindow). */
  window: CodeWindow;
  /** The domain this server's bots send mail from. */
  botEmailDomain: string | undefined;
};

/**
 * The code for `origin` in the bot's own inbox, if there is exactly one to take. It comes from
 * mail that may answer (emailMayAnswer: signed mail from the site's own domain, received in the
 * request's window, that no bot on this server sent), that came after the last answered code
 * request for the site, that no run took a code from, and that gives exactly one code
 * (readOneTimeCode). Emails that name no code are skipped; two with different codes give
 * nothing, and neither does any while one of them is unclear: it names a code but gives none to
 * take, so the others' are in doubt.
 * A run takes at most one emailed code per site; after that the owner answers the card.
 * Null when the inbox holds codes from the site but not one to take, or more mail than it reads:
 * no other source may answer then.
 */
export async function findEmailedCode(
  prisma: PrismaClient,
  input: CodeLook,
): Promise<MailCode | null | undefined> {
  const site = fillableSite(input.origin);
  if (!site) return undefined;
  const filled = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: runSiteClaimKey(input.runId, site) },
    select: { id: true },
  });
  if (filled) return undefined;
  const rule = { site, botEmailDomain: input.botEmailDomain, ...input.window };
  // The sender is encrypted, so the query asks for the window's mail (minutes long) that holds
  // the site's name, as the inbox's index of words can tell, and what it finds is read newest
  // first in batches, without subject or text, each filtered here. Mail that does not name the
  // site is neither read nor counted, however much there is; the limits are on mail that does,
  // and the search limit on the site's own, so other senders never hide the site's email. The
  // query only narrows what is read: emailMayAnswer decides each email, as for every other look.
  const inbox = await prisma.bot.findUnique({
    where: { id: input.botId },
    select: { spaceId: true },
  });
  if (!inbox) return undefined;
  const naming = await mailNaming(prisma, inbox.spaceId, site);
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
        receivedAt: { gte: rule.after, lte: rule.before },
        ...naming,
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
  const unclaimed = await unusedMail(prisma, input, site, fromSite);
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
 * Of mail that may answer, what the database says is still unused, as the claim will hold it to
 * (claimEmailedCode): no run took a code from the message, in whichever mailbox and Space, and
 * no code request for the site was answered since it came, in the runs that share the mail.
 */
async function unusedMail<T extends { key?: string; receivedAt: Date }>(
  prisma: PrismaClient,
  look: MailSharingRuns & { requestId: string },
  site: string,
  mail: T[],
): Promise<T[]> {
  if (mail.length === 0) return [];
  const older = await codeAnsweredSince(prisma, look, codeSite(site), {
    requestId: look.requestId,
    times: mail.map((one) => one.receivedAt),
  });
  const keys = mail.flatMap((one) => (one.key === undefined ? [] : [messageClaimKey(one.key)]));
  const claimed = new Set(
    keys.length === 0
      ? []
      : (
          await prisma.externalEffect.findMany({
            where: { idempotencyKey: { in: keys } },
            select: { idempotencyKey: true },
          })
        ).map((effect) => effect.idempotencyKey),
  );
  return mail.filter(
    (one, index) =>
      !older[index] && !(one.key !== undefined && claimed.has(messageClaimKey(one.key))),
  );
}

/**
 * The code for `origin` in the mailboxes the owner connected in the run's Space, if there is
 * exactly one to take, by the rules of findEmailedCode. Each mailbox lists what its provider
 * matches to the site, loosely, with each message's sender, size and arrival time and none of
 * its content. Only a message that may be the site's (its listed sender is on the site, or is
 * not told), that arrived in the request's window and after the last answered code request for
 * the site, is read: raw, so its signature can be checked, and only what emailMayAnswer with the
 * mailbox's own address gives a code. Mail from any other sender is never read and counts for
 * nothing. The whole read is bounded in time and, over the messages it reads, in bytes
 * (CONNECTED_MAIL_MAX_BYTES): one that may be the site's and does not fit, or whose size or
 * arrival time is not told, is not fetched and fails the look. It only ever reads. When it
 * fails for any reason, there is no code, and only the error's name is logged.
 */
export async function findConnectedMailCode(
  deps: ConnectedMailDeps,
  input: CodeLook,
): Promise<MailCode | undefined> {
  const { prisma } = deps;
  const site = fillableSite(input.origin);
  if (!site) return undefined;
  const filled = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: runSiteClaimKey(input.runId, site) },
    select: { id: true },
  });
  if (filled) return undefined;
  // Read at each request: the owner may have turned it on or off since the run began.
  const bot = await prisma.bot.findUnique({
    where: { id: input.botId },
    select: { connectedMailCodes: true, name: true },
  });
  if (!bot?.connectedMailCodes) return undefined;
  // The owner's own connections in the run's Space that are connected now, as every step
  // outside a model run reads them: asked afresh on each look, so one revoked or removed since
  // the last look is not read.
  const rows = await loadConnectedConnections(prisma, input);
  const readers = rows.flatMap((row) => {
    // Each read is given its one connection only, and only a connection that names the one
    // account its provider is to read (readerFor gives no reader for any other): the reader can
    // reach no other account, and the provider is never left to pick one.
    const context = connectedContext([row]);
    const connection = context.connectedConnections?.[0];
    const reader = connection && deps.connectedMail.readerFor(connection);
    return reader ? [{ row, context, reader }] : [];
  });
  if (readers.length === 0) return undefined;
  const rule = { site, botEmailDomain: deps.botEmailDomain, ...input.window };
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
          const listed = await reader.recent(context, {
            fromDomain: site,
            after: rule.after,
            limit: CONNECTED_MAIL_LIMIT,
            ...(page ? { page } : {}),
          });
          const mayBeSites: (ConnectedMailListing & { receivedAt: Date })[] = [];
          for (const message of listed.messages) {
            // The provider's match is loose: mail its listing says another sender sent is not
            // the site's, whatever its size or shape, so it is neither read nor counted.
            if (message.from !== undefined && !onSite(message.from, site)) continue;
            // A message that may be the site's and cannot be read or judged may hold the newest
            // code: the whole look fails, so the card opens rather than an older message
            // answering in its place.
            const { receivedAt } = message;
            if (!receivedAt) throw new Error("A message's arrival time is not known");
            if (arrivedIn(rule, receivedAt)) mayBeSites.push({ ...message, receivedAt });
          }
          for (const message of await unusedMail(prisma, input, site, mayBeSites)) {
            signal.throwIfAborted();
            // Fetched only when the provider says it fits what the look may still read, and held
            // to that again by what comes back, here as in the reader.
            if (message.size === undefined) throw new Error("A message's size is not known");
            if (message.size > left) throw new Error("A message from the site is too large");
            const raw = await reader.read(context, message.id, left);
            left -= raw.byteLength;
            if (left < 0) throw new Error("The mailbox returned more mail than the look may read");
            const email = await readInboundEmail(raw);
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
          page = listed.next;
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
  // A message another run took a code from since it was listed is not this request's.
  const newest = theOneCode(await unusedMail(prisma, input, site, candidates));
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
 * The email's code is not this request's to take: a run already took it, this run took one for
 * the site, the owner may have typed it, or another open request could take it too.
 */
export class EmailedCodeTaken extends Error {}

/**
 * Take the email's code for `runId` in `tx`, the transaction that keeps the code, deciding there
 * what only the database knows of the email, across every Space, while no code card of the
 * runs that share the mail can be answered (holdCodeAnswers): throws EmailedCodeTaken, which
 * rolls `tx` back, when a code request for the site was answered since the email came (the owner
 * may have typed its code), when another open request could take it too (asked for the same
 * site, in another run still going of the bot or of its owner, with the email in its window:
 * mail does not say which sign-in it is for, so it answers neither), when a run already took the
 * message's code, or when this run took one for the site. So a claim stands only with the kept
 * code, and a code that was kept is offered once: a claim is never given back. Every look takes
 * a code through here, whichever mailbox it read it from.
 */
export async function claimEmailedCode(
  tx: Prisma.TransactionClient,
  input: CodeMessage &
    MailSharingRuns & {
      runId: string;
      requestId: string;
      spaceId: string;
    },
): Promise<void> {
  const { receivedAt, requestId } = input;
  const site = codeSite(input.site);
  // Before anything is read: a card being answered meanwhile is waited for, and none is
  // answered until this is done, so what is read here still holds when the code is kept.
  await holdCodeAnswers(tx, input);
  const [used] = await codeAnsweredSince(tx, input, site, { requestId, times: [receivedAt] });
  if (used) throw new EmailedCodeTaken();
  // Another request's window holds the email when it asked within the window's reach of it.
  const others = {
    runId: input.runId,
    askedFrom: new Date(receivedAt.getTime() - EMAILED_CODE_WINDOW_MS),
    askedTo: new Date(receivedAt.getTime() + EMAILED_CODE_WINDOW_MS),
    runStartedBy: receivedAt,
  };
  if (await otherCodeRequestOpen(tx, input, site, others)) throw new EmailedCodeTaken();
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
  input: CodeLook & { sources: CodeSources },
): Promise<FoundCode | undefined> {
  const { runId, requestId, spaceId, botId, userId } = input;
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
    claim: (tx) => claimEmailedCode(tx, { ...message, runId, requestId, spaceId, botId, userId }),
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
 * a card for a code (not a login), whose browser was on the card's origin when it asked, while
 * the request's window is open: mail that comes after it is not the request's. With `runId`,
 * only that run, whose look also reads the owner's connected mail.
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
    const window = emailedCodeWindow(request.createdAt, run.createdAt);
    // Nothing that arrives now is in the window, and what did was looked at when it came.
    if (window.before < new Date()) continue;
    const found = await findCodeForRequest(deps.prisma, {
      botId: bot.id,
      spaceId: run.spaceId,
      runId: run.id,
      requestId: request.id,
      userId: bot.userId,
      origin,
      window,
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
 * request could take the email too, the claim refuses it and the card stays, so mail two cards
 * wait for answers neither. The card's own answer path settles a race with the owner:
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
