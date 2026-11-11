import { createHash } from "node:crypto";
import type {
  AdapterContext,
  BrowserProvider,
  ComputerRef,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { extractOneTimeCode } from "@rakazo/contracts";
import { isMessagingChannelRun } from "@rakazo/core";
import { hostSite } from "@rakazo/core/egress";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { findPendingAsk, teamChatRunFromOwner } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** How long before a code request an email may have arrived and still answer it. */
export const EMAILED_CODE_WINDOW_MS = 5 * 60 * 1000;
/** The earliest an email may have arrived to answer a code request: in its run, shortly before. */
export function emailedCodeWindowStart(requestedAt: Date, runStartedAt: Date): Date {
  return new Date(Math.max(requestedAt.getTime() - EMAILED_CODE_WINDOW_MS, runStartedAt.getTime()));
}
/** Emails read from the inbox per query while looking for the site's: its sender is encrypted. */
const EMAIL_BATCH = 50;
/**
 * The most emails in the window read for one lookup, the inbox's daily limit for unsolicited
 * mail: a window is minutes long, so mail from other senders never hides the site's email.
 */
export const EMAIL_SEARCH_LIMIT = 500;

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

function httpsSite(origin: string): string | undefined {
  const url = URL.canParse(origin) ? new URL(origin) : undefined;
  return url?.protocol === "https:" ? hostSite(url.hostname) : undefined;
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/**
 * The code for `origin` in the bot's own inbox, if there is exactly one to take. It comes from
 * signed mail from the site's own domain (subdomains of a shared hosting suffix are each their
 * own site), received since `after`, that the bot did not send and no bot on this server did,
 * that no run took a code from, and that holds exactly one code. Emails with none or several are
 * skipped, and two such emails with different codes give nothing. An email that came before any
 * of the bot's secret requests was answered may hold the code that answer used, so it is not one.
 * A run takes at most one emailed code per site; after that the owner answers the card.
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
): Promise<{ code: string; emailId: string; emailKey: string; site: string } | undefined> {
  const site = httpsSite(input.origin);
  if (!site) return undefined;
  const filled = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: runSiteClaimKey(input.runId, site) },
    select: { id: true },
  });
  if (filled) return undefined;
  const answered = await prisma.externalEffect.findFirst({
    where: {
      spaceId: input.spaceId,
      kind: "request_secret",
      status: { not: "intended" },
      updatedAt: { gte: input.after },
      run: { botId: input.botId },
    },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  // The sender is encrypted, so the window is read newest first in batches, each filtered here,
  // up to EMAIL_SEARCH_LIMIT emails: the limit is on the site's mail, not on everyone's.
  const fromSite: { id: string; key: string; subject: string; text: string }[] = [];
  let cursor: string | undefined;
  for (let read = 0; read < EMAIL_SEARCH_LIMIT; read += EMAIL_BATCH) {
    const emails = await prisma.botEmailMessage.findMany({
      where: {
        botId: input.botId,
        sent: false,
        verified: true,
        mailingList: false,
        receivedAt: { gte: input.after, ...(answered ? { gt: answered.updatedAt } : {}) },
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: Math.min(EMAIL_BATCH, EMAIL_SEARCH_LIMIT - read),
      select: { id: true, key: true, fromAddress: true, subject: true, text: true },
    });
    for (const email of emails) {
      const domain = domainOf(email.fromAddress);
      if (domain !== input.botEmailDomain && hostSite(domain) === site) fromSite.push(email);
    }
    cursor = emails.at(-1)?.id;
    if (emails.length < EMAIL_BATCH) break;
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
  const candidates = fromSite.flatMap((email) => {
    const code = claimed.has(claimOf(email)) ? undefined : extractOneTimeCode(email);
    return code ? [{ code, emailId: email.id, emailKey: email.key }] : [];
  });
  const [newest] = candidates;
  if (!newest || candidates.some((candidate) => candidate.code !== newest.code)) return undefined;
  return { ...newest, site };
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
  const keys = [
    runSiteClaimKey(input.runId, input.site),
    emailClaimKey(input.botId, input.emailKey),
  ];
  const { count } = await tx.externalEffect.createMany({
    data: keys.map((idempotencyKey) => ({
      runId: input.runId,
      spaceId: input.spaceId,
      kind: EMAILED_CODE_EFFECT,
      status: "taken",
      idempotencyKey,
      request: { emailId: input.emailId, site: input.site },
    })),
    skipDuplicates: true,
  });
  if (count !== keys.length) throw new EmailedCodeTaken();
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
 * Find the inbox's code for a request and keep it with `keep`, which makes the claim it is given
 * in the transaction that stores the code (claimEmailedCode): nothing when there is no code or
 * another run took it first. When keeping fails, the email stays for the next try.
 */
export async function takeEmailedCode<T>(
  prisma: PrismaClient,
  input: Parameters<typeof findEmailedCode>[1],
  keep: (
    found: { code: string; emailId: string },
    claim: (tx: Prisma.TransactionClient) => Promise<void>,
  ) => Promise<T>,
): Promise<T | undefined> {
  const found = await findEmailedCode(prisma, input);
  if (!found) return undefined;
  const claim = (tx: Prisma.TransactionClient) =>
    claimEmailedCode(tx, {
      runId: input.runId,
      spaceId: input.spaceId,
      botId: input.botId,
      emailId: found.emailId,
      emailKey: found.emailKey,
      site: found.site,
    });
  try {
    return await keep({ code: found.code, emailId: found.emailId }, claim);
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
    const answers: Array<{
      run: (typeof runs)[number];
      messageId: string;
      found: { code: string; emailId: string; emailKey: string; site: string };
    }> = [];
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
      const found = await findEmailedCode(deps.prisma, {
        botId: bot.id,
        spaceId: run.spaceId,
        runId: run.id,
        origin,
        after: emailedCodeWindowStart(request.createdAt, run.createdAt),
        botEmailDomain: deps.botEmailDomain,
      });
      if (found) answers.push({ run, messageId: pending.messageId, found });
    }
    for (const { run, messageId, found } of answers) {
      if (runId && run.id !== runId) continue;
      if (answers.filter((other) => other.found.emailId === found.emailId).length > 1) continue;
      try {
        const answered = await deps.events.answerRunInput({
          spaceId: run.spaceId,
          threadId: run.threadId,
          runId: run.id,
          messageId,
          answeredByUserId: run.userId,
          answer: found.code,
          fromEmail: found.emailId,
          // In the answer's own transaction, so a card that is not answered leaves the email.
          claimEmail: (tx) =>
            claimEmailedCode(tx, {
              runId: run.id,
              spaceId: run.spaceId,
              botId: bot.id,
              emailId: found.emailId,
              emailKey: found.emailKey,
              site: found.site,
            }),
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
