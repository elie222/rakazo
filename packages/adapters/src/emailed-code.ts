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
import { extractOneTimeCode } from "@rakazo/contracts";
import { isMessagingChannelRun, PUBLIC_MAILBOX_DOMAINS } from "@rakazo/core";
import { hostSite } from "@rakazo/core/egress";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { findPendingAsk, teamChatRunFromOwner } from "@rakazo/db";
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
 * The claim on an email is on the message, not the row: the same message delivered again after
 * its row was deleted (a relay's retry, the bot's delete_email) has the same key and is not new.
 */
const emailClaimKey = (botId: string, key: string) =>
  `emailed-code:email:${botId}:${createHash("sha256").update(key).digest("base64url")}`;
const runSiteClaimKey = (runId: string, site: string) => `emailed-code:run:${runId}:${site}`;
const pageSeenKey = (requestId: string) => `emailed-code:page:${requestId}`;
/**
 * The claim on a message in a connected mailbox: on the provider's id for it in that mailbox, so
 * two connections to one mailbox share it.
 */
const connectedClaimKey = (mailbox: string, messageId: string) =>
  `emailed-code:connected:${createHash("sha256").update(`${mailbox}:${messageId}`).digest("base64url")}`;
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

/**
 * Whether an email may answer a code request for `site`, from whichever mailbox it was read: it
 * is signed by its From domain, which is the site's own (subdomains of a shared hosting suffix are
 * each their own site), not a public mailbox domain, not this server's, is known not to have come
 * through a mailing list (null: saved before that was told apart), and, for a mailbox someone
 * connected, was sent to that mailbox itself.
 */
export function emailMayAnswer(
  email: {
    fromAddress: string | null | undefined;
    verified: boolean;
    mailingList: boolean | null;
    recipients?: string[];
  },
  rule: { site: string; botEmailDomain: string | undefined; mailbox?: string },
): boolean {
  if (!email.fromAddress || !email.verified || email.mailingList !== false) return false;
  const domain = domainOf(email.fromAddress);
  if (domain === rule.botEmailDomain || hostSite(domain) !== rule.site) return false;
  if (publicMailboxDomain(rule.site)) return false;
  if (rule.mailbox === undefined) return true;
  const mailbox = rule.mailbox.toLowerCase();
  // Anyone with an address on the mailbox's own domain can send it mail that domain signs.
  if (hostSite(domainOf(mailbox)) === rule.site) return false;
  return (email.recipients ?? []).some((address) => address.toLowerCase() === mailbox);
}

/** The one code the emails that may answer hold, newest first; nothing when they differ. */
function theOneCode<T extends { code: string }>(candidates: T[]): T | undefined {
  const [newest] = candidates;
  if (!newest || candidates.some((candidate) => candidate.code !== newest.code)) return undefined;
  return newest;
}

/**
 * When the newest secret request of the bot, or with `userId` of any run of that user's too, was
 * answered since `after`: older mail may hold its code.
 */
async function lastAnsweredAt(
  prisma: PrismaClient,
  input: { botId: string; spaceId: string; after: Date; userId?: string },
): Promise<Date | undefined> {
  const answered = await prisma.externalEffect.findFirst({
    where: {
      spaceId: input.spaceId,
      kind: "request_secret",
      status: { not: "intended" },
      updatedAt: { gte: input.after },
      run: input.userId
        ? { OR: [{ botId: input.botId }, { userId: input.userId }] }
        : { botId: input.botId },
    },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  return answered?.updatedAt;
}

/**
 * The code for `origin` in the bot's own inbox, if there is exactly one to take. It comes from
 * signed mail from the site's own domain (subdomains of a shared hosting suffix are each their
 * own site), received since `after`, that the bot did not send and no bot on this server did,
 * that no run took a code from, and that holds exactly one code. Emails with none or several are
 * skipped, and two such emails with different codes give nothing. An email that came before any
 * of the bot's secret requests was answered may hold the code that answer used, so it is not one.
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
    origin: string;
    after: Date;
    /** The domain this server's bots send mail from. */
    botEmailDomain: string | undefined;
  },
): Promise<{ code: string; emailId: string; emailKey: string; site: string } | null | undefined> {
  const site = fillableSite(input.origin);
  if (!site) return undefined;
  const filled = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: runSiteClaimKey(input.runId, site) },
    select: { id: true },
  });
  if (filled) return undefined;
  const answered = await lastAnsweredAt(prisma, {
    botId: input.botId,
    spaceId: input.spaceId,
    after: input.after,
  });
  // The sender is encrypted, so the whole window (minutes long) is read newest first in batches,
  // without subject or text, each filtered here: the limit is on the site's mail, so mail from
  // other senders, however much, never hides the site's email.
  const fromSite: { id: string; key: string }[] = [];
  let cursor: string | undefined;
  let read = 0;
  while (true) {
    const emails = await prisma.botEmailMessage.findMany({
      where: {
        botId: input.botId,
        sent: false,
        verified: true,
        mailingList: false,
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
      },
    });
    for (const email of emails) {
      if (emailMayAnswer(email, { site, botEmailDomain: input.botEmailDomain }))
        fromSite.push(email);
    }
    // Older mail from the site left unread may hold another code: the card stays instead.
    if (fromSite.length > EMAIL_SEARCH_LIMIT) return null;
    cursor = emails.at(-1)?.id;
    read += emails.length;
    if (emails.length < EMAIL_BATCH) break;
    // Older mail left unread may hold another code from the site: the card stays instead.
    if (read >= EMAIL_READ_LIMIT) return null;
  }
  if (fromSite.length === 0) return undefined;
  const claimOf = (email: { key: string }) => emailClaimKey(input.botId, email.key);
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
  // One was deleted meanwhile and might have held another code.
  if (bodies.size !== unclaimed.length) return null;
  const candidates = unclaimed.flatMap((email) => {
    const body = bodies.get(email.id);
    const code = body && extractOneTimeCode(body);
    return code ? [{ code, emailId: email.id, emailKey: email.key }] : [];
  });
  const newest = theOneCode(candidates);
  return newest ? { ...newest, site } : candidates.length > 0 ? null : undefined;
}

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
 * emailMayAnswer with the mailbox's own address. The whole read is bounded in time and only ever
 * reads. When it fails for any reason, there is no code, and only the error's name is logged.
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
): Promise<{ code: string; mailbox: string; messageId: string; site: string } | undefined> {
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
    select: { connectedMailCodes: true },
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
  // The mailbox is the owner's: the owner may have typed its code into any of their runs' cards.
  const answered = await lastAnsweredAt(prisma, input);
  const since = answered && answered > input.after ? answered : input.after;
  const candidates: { code: string; mailbox: string; messageId: string }[] = [];
  const signal = AbortSignal.timeout(CONNECTED_MAIL_TIMEOUT_MS);
  try {
    await bounded(signal, async () => {
      for (const { row, context: connected, reader } of readers) {
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
            after: input.after,
            limit: CONNECTED_MAIL_LIMIT,
            ...(page ? { page } : {}),
          });
          for (const message of read.messages) {
            signal.throwIfAborted();
            // A message that cannot be judged may hold the newest code: the whole look fails, so
            // the card opens rather than an older message answering in its place.
            if (!message.receivedAt) throw new Error("A message's arrival time is not known");
            if (message.receivedAt <= since) continue;
            const email = await readInboundEmail(message.raw);
            if (email.temporaryFailure) throw new Error("A message's signature cannot be checked");
            const mayAnswer = emailMayAnswer(
              {
                fromAddress: email.from?.address,
                verified: email.authenticated,
                mailingList: email.mailingList,
                recipients: [...email.to, ...email.cc],
              },
              { site, botEmailDomain: deps.botEmailDomain, mailbox },
            );
            if (!mayAnswer) continue;
            // An older message from the site left unread may hold another code.
            if (++fromSite > CONNECTED_MAIL_LIMIT)
              throw new Error("The site sent too many messages");
            const code = extractOneTimeCode(email);
            if (code) candidates.push({ code, mailbox, messageId: message.id });
          }
          page = read.next;
        } while (page);
      }
    });
  } catch (error) {
    getLogger().warn("connected mail could not be read for a code", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
  if (candidates.length === 0) return undefined;
  const claimOf = (found: { mailbox: string; messageId: string }) =>
    connectedClaimKey(found.mailbox, found.messageId);
  const claimed = new Set(
    (
      await prisma.externalEffect.findMany({
        where: { idempotencyKey: { in: candidates.map(claimOf) } },
        select: { idempotencyKey: true },
      })
    ).map((effect) => effect.idempotencyKey),
  );
  const newest = theOneCode(candidates.filter((found) => !claimed.has(claimOf(found))));
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

/** Another run, or this run for the same site, already took the email's code. */
export class EmailedCodeTaken extends Error {}

/**
 * Take the email's code for `runId` in `tx`, the transaction that keeps the code: throws
 * EmailedCodeTaken when it was already taken, which rolls `tx` back. So a claim stands only with
 * the kept code, and a code that was kept is offered once: a claim is never given back.
 */
export async function claimEmailedCode(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    spaceId: string;
    botId: string;
    emailId: string;
    /** The email's message key, the same for every delivery of the message. */
    emailKey: string;
    site: string;
  },
): Promise<void> {
  await claimCode(tx, {
    runId: input.runId,
    spaceId: input.spaceId,
    site: input.site,
    key: emailClaimKey(input.botId, input.emailKey),
    request: { emailId: input.emailId, site: input.site },
  });
}

/** As claimEmailedCode, for a message in a mailbox the owner connected. */
export async function claimConnectedMailCode(
  tx: Prisma.TransactionClient,
  input: { runId: string; spaceId: string; mailbox: string; messageId: string; site: string },
): Promise<void> {
  await claimCode(tx, {
    runId: input.runId,
    spaceId: input.spaceId,
    site: input.site,
    key: connectedClaimKey(input.mailbox, input.messageId),
    request: { site: input.site },
  });
}

/** The site's claim for the run and the message's own, both or neither, whichever mailbox. */
async function claimCode(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    spaceId: string;
    site: string;
    key: string;
    request: Prisma.InputJsonObject;
  },
): Promise<void> {
  const keys = [runSiteClaimKey(input.runId, input.site), input.key];
  const { count } = await tx.externalEffect.createMany({
    data: keys.map((idempotencyKey) => ({
      runId: input.runId,
      spaceId: input.spaceId,
      kind: EMAILED_CODE_EFFECT,
      status: "taken",
      idempotencyKey,
      request: input.request,
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
  input: Parameters<typeof findEmailedCode>[1] & { userId: string; sources: CodeSources },
): Promise<FoundCode | undefined> {
  const emailed = input.sources.inbox ? await findEmailedCode(prisma, input) : undefined;
  // The inbox holds the site's mail but no one code: the card is the owner's.
  if (emailed === null) return undefined;
  if (emailed) {
    return {
      code: emailed.code,
      site: emailed.site,
      fromEmail: emailed.emailId,
      claim: (tx) =>
        claimEmailedCode(tx, {
          runId: input.runId,
          spaceId: input.spaceId,
          botId: input.botId,
          emailId: emailed.emailId,
          emailKey: emailed.emailKey,
          site: emailed.site,
        }),
    };
  }
  if (!input.sources.connected) return undefined;
  const found = await findConnectedMailCode(
    { prisma, connectedMail: input.sources.connected, botEmailDomain: input.botEmailDomain },
    input,
  );
  if (!found) return undefined;
  return {
    code: found.code,
    site: found.site,
    fromEmail: connectedClaimKey(found.mailbox, found.messageId),
    claim: (tx) =>
      claimConnectedMailCode(tx, {
        runId: input.runId,
        spaceId: input.spaceId,
        mailbox: found.mailbox,
        messageId: found.messageId,
        site: found.site,
      }),
  };
}

/** Whether the run took a code from its inbox: its claim is made with the kept code, at once. */
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
 * code or another run took it first. When keeping fails, the email stays for the next try.
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
 * New mail in a bot's inbox answers the code card its owner's run is waiting on, when the mail
 * holds the one code for the card's site, as the owner would by typing it in; the run then goes
 * on. Only a card whose run's browser was on the card's origin when it asked, and an email
 * claimed for that run, as findEmailedCode and claimEmailedCode decide. An email that would answer
 * two waiting cards answers neither. The card's own answer path settles a race with the owner:
 * whichever comes second finds the card answered and does nothing. With `runId`, only that run's
 * card: the run looks again once it waits, for mail that came while it was saving the card, and
 * still answers neither when the email would also answer another run's card.
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
    const runs = await deps.prisma.run.findMany({
      where: {
        botId: bot.id,
        userId: bot.userId,
        status: "waiting_input",
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
        sources: { inbox: true, connected: run.id === runId ? deps.connectedMail : undefined },
      });
      if (found) answers.push({ run, messageId: pending.messageId, found });
    }
    for (const { run, messageId, found } of answers) {
      if (runId && run.id !== runId) continue;
      if (answers.filter((other) => other.found.fromEmail === found.fromEmail).length > 1) continue;
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
    // The email is saved either way; the card stays open for the owner.
    getLogger().error("emailed code lookup", error);
  }
  return count;
}
