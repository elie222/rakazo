import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { runAsSystemInTransaction } from "./row-security.js";

/**
 * The runs whose sign-in codes can be in the same mail: every run of a bot, whose address its
 * sites write to, and every run of the bot's owner, whose own mailbox the bot may read. They can
 * be in any Space: the owner's mailbox is one, whichever Space reads it.
 */
export type MailSharingRuns = { botId: string; userId: string };

/** A site as a code request names it: text every origin on it holds, and the test of one. */
export type CodeSite = { name: string; holds: (origin: string) => boolean };

/** The most code requests for one site read for one question: past it the answer is yes. */
export const CODE_REQUEST_LIMIT = 100;

/**
 * The kind of what is kept about codes from mail, as effects of the run they are about: the
 * claims on an email's code, the page a request was made on, and when a code card was answered.
 * `idempotencyKey` is unique, so inserting a claim takes it, and two runs (or a run and the
 * inbox) never both get it. Their status is none a tool's effect has, so nothing replays or
 * reads them as tool calls.
 */
export const EMAILED_CODE_EFFECT = "emailed_code";
/** The note of when the card of a code request was answered (noteCodeAnswered). */
const codeAnsweredKey = (requestId: string) => `emailed-code:answered:${requestId}`;

/**
 * The code requests for `site` in those runs that `where` picks, or nothing when there are more
 * than CODE_REQUEST_LIMIT. Read as a system step: a run's own queries see only its Space's runs,
 * and these can be in any. What is read stays in this file: its callers get yes or no.
 */
async function siteCodeRequests(
  client: PrismaClient | Prisma.TransactionClient,
  runs: MailSharingRuns,
  site: CodeSite,
  where: Prisma.ExternalEffectWhereInput,
  run: Prisma.RunWhereInput = {},
) {
  const read = () =>
    client.externalEffect.findMany({
      where: {
        ...where,
        kind: "request_secret",
        // Narrows to the site's requests; `holds` then decides each.
        request: { path: ["oneTimeCode", "origin"], string_contains: site.name },
        run: { ...run, OR: [{ botId: runs.botId }, { userId: runs.userId }] },
      },
      select: { id: true, request: true, updatedAt: true },
      take: CODE_REQUEST_LIMIT + 1,
    });
  // The same step whether or not the caller is in a transaction: inside one, the connection
  // keeps the tenant's settings, so the system step is switched on there and back off after.
  const reason = "read the code requests of a bot's and its owner's runs in every Space";
  const rows = await runAsSystemInTransaction(client, reason, read);
  if (rows.length > CODE_REQUEST_LIMIT) return undefined;
  return rows.filter(({ request }) => {
    const origin = codeRequestOrigin(request);
    return origin !== undefined && site.holds(origin);
  });
}

/** The page a secret request asks a code for; nothing when it asks for something else. */
function codeRequestOrigin(request: Prisma.JsonValue): string | undefined {
  const origin = (request as { oneTimeCode?: { origin?: unknown } } | null)?.oneTimeCode?.origin;
  return typeof origin === "string" ? origin : undefined;
}

/**
 * Keep out, until `tx` ends, every other transaction that answers a code card of those runs or
 * takes a code from mail for them, and wait for one under way. Both call this before they read
 * or write what the other decides by, so the two never pass each other: a code is taken either
 * before a card was answered or knowing that it was. The locks are taken in one order
 * everywhere, so no two transactions wait on each other.
 */
export async function holdCodeAnswers(
  tx: Prisma.TransactionClient,
  runs: MailSharingRuns,
): Promise<void> {
  for (const key of [`code-answers:bot:${runs.botId}`, `code-answers:user:${runs.userId}`].sort())
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS "lock"`;
}

/**
 * Note, in the transaction that answers a code card, when it was answered: for each code
 * request among `open`, the run's requests the answer settles, a row of its own that nothing
 * changes afterwards. `runs` are the card's run's bot and user. The
 * request's own row changes again as the run uses the answer, so its last change says only
 * that the answer came no later. Holds off codes taken from mail meanwhile (holdCodeAnswers).
 */
export async function noteCodeAnswered(
  tx: Prisma.TransactionClient,
  runs: MailSharingRuns,
  open: { runId: string; spaceId: string; kind: string; status: string },
): Promise<void> {
  await holdCodeAnswers(tx, runs);
  const asked = await tx.externalEffect.findMany({
    where: open,
    select: { id: true, request: true },
  });
  const requests = asked.filter(({ request }) => codeRequestOrigin(request) !== undefined);
  if (requests.length === 0) return;
  await tx.externalEffect.createMany({
    data: requests.map(({ id }) => ({
      runId: open.runId,
      spaceId: open.spaceId,
      kind: EMAILED_CODE_EFFECT,
      status: "answered",
      idempotencyKey: codeAnsweredKey(id),
      request: {},
    })),
    skipDuplicates: true,
  });
}

/**
 * For each of `times`, whether a code request for the site in those runs, in any Space, other
 * than `requestId`, was answered at or after it: it is no longer open, whether a code was typed
 * into its card, taken from mail for it, or it was closed without one. An email that arrived
 * before that may hold the code it used: the owner may have typed it into any of their cards for
 * the site. `requestId` is the request the question is asked for, which a call may already hold.
 * The time compared is when the card was answered, where that was noted (noteCodeAnswered), and
 * otherwise when the request's row last changed, which is no earlier.
 */
export async function codeAnsweredSince(
  client: PrismaClient | Prisma.TransactionClient,
  runs: MailSharingRuns,
  site: CodeSite,
  input: { requestId: string; times: Date[] },
): Promise<boolean[]> {
  const { times } = input;
  if (times.length === 0) return [];
  const earliest = new Date(Math.min(...times.map((time) => time.getTime())));
  const answered = await siteCodeRequests(client, runs, site, {
    id: { not: input.requestId },
    status: { not: "intended" },
    updatedAt: { gte: earliest },
  });
  // More than are read: one left out may be newer than any of them.
  if (!answered) return times.map(() => true);
  const notes =
    answered.length === 0
      ? []
      : await client.externalEffect.findMany({
          where: { idempotencyKey: { in: answered.map(({ id }) => codeAnsweredKey(id)) } },
          select: { idempotencyKey: true, createdAt: true },
        });
  const noted = new Map(notes.map((note) => [note.idempotencyKey, note.createdAt]));
  const newest = Math.max(
    ...answered.map(({ id, updatedAt }) => (noted.get(codeAnsweredKey(id)) ?? updatedAt).getTime()),
  );
  return times.map((time) => time.getTime() <= newest);
}

/**
 * Whether another code request for the site is open in those runs, in any Space: asked between
 * `askedFrom` and `askedTo` and not answered, in a run other than `runId` that is still going
 * and had started by `runStartedBy`. A request a call holds while it works on it (executing) may
 * be waiting for its code or using the answer it got: it counts as open here, and as answered in
 * codeAnsweredSince. Called in the transaction that takes a code, which it may then refuse.
 */
export async function otherCodeRequestOpen(
  tx: Prisma.TransactionClient,
  runs: MailSharingRuns,
  site: CodeSite,
  input: { runId: string; askedFrom: Date; askedTo: Date; runStartedBy: Date },
): Promise<boolean> {
  const open = await siteCodeRequests(
    tx,
    runs,
    site,
    {
      status: { in: ["intended", "executing"] },
      runId: { not: input.runId },
      createdAt: { gte: input.askedFrom, lte: input.askedTo },
    },
    { status: { in: [...ACTIVE_RUN_STATUSES] }, createdAt: { lte: input.runStartedBy } },
  );
  // More than are read count as one that is open.
  return !open || open.length > 0;
}
