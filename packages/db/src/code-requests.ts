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
      select: { request: true, updatedAt: true },
      take: CODE_REQUEST_LIMIT + 1,
    });
  // The same step whether or not the caller is in a transaction: inside one, the connection
  // keeps the tenant's settings, so the system step is switched on there and back off after.
  const reason = "read the code requests of a bot's and its owner's runs in every Space";
  const rows = await runAsSystemInTransaction(client, reason, read);
  if (rows.length > CODE_REQUEST_LIMIT) return undefined;
  return rows.filter(({ request }) => {
    const origin = (request as { oneTimeCode?: { origin?: unknown } } | null)?.oneTimeCode?.origin;
    return typeof origin === "string" && site.holds(origin);
  });
}

/**
 * For each of `times`, whether a code request for the site in those runs, in any Space, other
 * than `requestId`, was answered at or after it: it is no longer open, whether a code was typed
 * into its card, taken from mail for it, or it was closed without one. An email that arrived
 * before that may hold the code it used: the owner may have typed it into any of their cards for
 * the site. `requestId` is the request the question is asked for, which a call may already hold.
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
  const newest = Math.max(...answered.map((request) => request.updatedAt.getTime()));
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
