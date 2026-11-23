import { createHmac } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import { resolveEncryptionKey } from "@rakazo/core/node/secrets-guard";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { runCodeKind, runCodeSpentKind, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { NOT_HTTPS_CODE } from "../bot-secret-destination.js";
import type { BotSecretScope } from "./vault-access.js";
import { oneTimeCodeRedactions } from "./vault-redaction.js";

const RunCodeValue = z.object({ origin: z.string(), code: z.string() });

/** A code answered in chat, kept with the site it is for until it is typed there. */
export function encodeRunCode(origin: string, code: string): string {
  return JSON.stringify({ origin, code });
}

/** The run's code row as stored, or nothing when it cannot be read; only the error name is logged. */
export async function readRunCode(
  secretStore: Pick<SecretStore, "load">,
  row: { id: string; ciphertext: string },
): Promise<{ origin: string; code: string } | undefined> {
  try {
    return RunCodeValue.parse(JSON.parse(await secretStore.load(row.ciphertext, row.id)));
  } catch (error) {
    getLogger().warn("one-time code could not be read", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

/**
 * Redaction forms of this run's codes, those waiting and those the page took, from the start of
 * every attempt: a filled code stays on its page and in what the run has read.
 */
export async function loadRunCodeRedactions(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  runId: string,
): Promise<string[]> {
  const rows = await prisma.secret.findMany({
    where: {
      userId: scope.userId,
      spaceId: scope.spaceId,
      kind: { in: [runCodeKind(runId), runCodeSpentKind(runId)] },
    },
    select: { id: true, ciphertext: true },
  });
  const forms = new Set<string>();
  for (const row of rows) {
    const held = await readRunCode(secretStore, row);
    for (const form of held ? oneTimeCodeRedactions(held.code) : []) forms.add(form);
  }
  return [...forms];
}

const NO_CODE_WAITING =
  "No code is waiting. Use request_secret with oneTimeCode to ask the user for it first.";

/**
 * This run's code for a page fill. Like a login's, the caller must pass `origin` to the page
 * browser, which refuses to fill unless the page is still on it. The code is only read here:
 * `claim` takes it for one fill, atomically, so two fills never both get it (the loser gets why),
 * and `restore` gives it back when the page refused, so the fill can be tried again on the right
 * page. A claimed code stays as a spent row, which the run keeps hiding until it ends.
 */
export async function resolveCodeFill(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  runId: string;
}): Promise<
  | {
      text: string;
      origin: string;
      redactions: string[];
      claim: () => Promise<string | undefined>;
      restore: () => Promise<void>;
    }
  | { error: string }
> {
  const where = { userId: input.scope.userId, spaceId: input.scope.spaceId };
  const row = await input.prisma.secret.findFirst({
    where: { ...where, kind: runCodeKind(input.runId) },
    select: { id: true, ciphertext: true },
  });
  if (!row) return { error: NO_CODE_WAITING };
  const held = await readRunCode(input.secretStore, row);
  if (!held) return { error: "This code could not be loaded." };
  if (!URL.canParse(held.origin) || new URL(held.origin).protocol !== "https:")
    return { error: NOT_HTTPS_CODE };
  const move = async (from: string, to: string) =>
    (
      await input.prisma.secret.updateMany({
        where: { id: row.id, kind: from },
        data: { kind: to },
      })
    ).count === 1;
  return {
    text: held.code,
    origin: held.origin,
    redactions: oneTimeCodeRedactions(held.code),
    claim: async () =>
      (await move(runCodeKind(input.runId), runCodeSpentKind(input.runId)))
        ? undefined
        : NO_CODE_WAITING,
    restore: async () => {
      await move(runCodeSpentKind(input.runId), runCodeKind(input.runId));
    },
  };
}

export const LOGIN_CODE_CHANGED =
  "The authenticator moved on to its next code before this one could be typed, so nothing was typed. Call browser_act again.";
export const LOGIN_REMOVED =
  "This login is no longer saved, so nothing was typed. Use request_secret with oneTimeCode to ask the user for the code.";
export const LOGIN_VALUE_CHANGED =
  "This login changed before its code could be typed, so nothing was typed. Call browser_act again.";
export const CODE_ALREADY_TYPED =
  "This code was already typed in this run. Wait for the authenticator's next code, then call fill_code again.";

/**
 * Codes of one login a run types; a site that refused them all likely has another key, so once a
 * run has typed that many, no run types its codes until the login is saved again.
 */
export const LOGIN_CODE_TRIES = 3;
/**
 * How soon after a login's code was typed the next request for one reads as the site asking
 * again. The backend can't see whether a site took a code; a wrong key is told apart from a
 * working one used several times by its codes coming in quick succession.
 */
export const LOGIN_CODE_REPEAT_WINDOW_MS = 5 * 60_000;
export const LOGIN_CODES_USED_UP = `A site asked for this login's authenticator code ${LOGIN_CODE_TRIES} times in a row, so its saved key may be wrong, and none are typed until the user saves the login again. Use request_secret with oneTimeCode to ask the user for the code.`;

/**
 * Typing a saved login's authenticator code once in this run. The state, all of it under the
 * login's row lock:
 * - The login is stopped or not (`codesStoppedAt`). Only the claim below stops it; only its
 *   owner's own save of its value clears it. A relabel changes neither, nor does a save a bot
 *   started, such as a login card answered in chat: it keeps the key that was stopped.
 * - Per run and saved value the code came from (the row's ciphertext; a save makes a new one),
 *   the codes claimed, each with the time it was claimed, as spent run codes the run's later
 *   attempts reload to hide. Codes of an earlier value are never counted again.
 * A claim of a code:
 * - is refused with LOGIN_REMOVED when the login was removed since the fill read it;
 * - is refused with LOGIN_VALUE_CHANGED when the login value changed since the fill read it;
 * - is refused with LOGIN_CODES_USED_UP while the login is stopped, for every run and value;
 * - is refused with CODE_ALREADY_TYPED when this run claimed the same code of this value;
 * - else counts `asked`: this code, plus the run's earlier codes of this value walking back
 *   from now, each claimed within LOGIN_CODE_REPEAT_WINDOW_MS of the one after it (the site
 *   asked again, which is what a refusal looks like from here; the backend can't see whether
 *   a site took a code). A code outside the window starts over, so a working key is used as
 *   often as runs need;
 * - past LOGIN_CODE_TRIES is refused with LOGIN_CODES_USED_UP;
 * - else is written, and when `asked` reaches LOGIN_CODE_TRIES with the saved value still the
 *   one the code came from, the login is stopped at this claim's time, keeping `updatedAt` so
 *   an approval given for the login holds. Parallel claims are serialised by the lock, so at
 *   most three count and exactly one stops.
 * A restore, for a code the page clearly never typed, deletes the claim, and clears the stop
 * when it is this run's (set at this or a remaining claim's time) and fewer than
 * LOGIN_CODE_TRIES codes now stand within the window of each other up to that time; a stop
 * three other codes still justify stays. A fill the page may have typed changes nothing: the
 * stop stands. Webhook and helper runs are refused before any fill, by the tool gate.
 */
export function loginCodeClaim(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "put">;
  scope: BotSecretScope;
  runId: string;
  /** The saved login and the stored value the code came from; a save since keeps its codes. */
  login: { id: string; ciphertext: string };
  origin: string;
  code: string;
}) {
  const { prisma, scope, runId } = input;
  // Keyed with the deployment's secret, as parallel-web's session ids are: a plain hash of a
  // six-digit code could be reversed by anyone who can read the table.
  const keyed = (text: string, length: number) =>
    createHmac("sha256", resolveEncryptionKey())
      .update("rakazo:vault-code-claim:v1\0")
      .update(text)
      .digest("hex")
      .slice(0, length);
  // Starts the same for each code of this value of the login in this run, so the run counts
  // them, and the codes of a value the owner has replaced no longer.
  const value = `${runId}:${input.login.id}:${input.login.ciphertext}`;
  const login = `run-totp-${keyed(value, 16)}-`;
  const id = `${login}${keyed(`${value}:${input.code}`, 32)}`;
  const spentKind = runCodeSpentKind(runId);
  // The run's codes of this value, latest first.
  const claimed = async (tx: Prisma.TransactionClient) =>
    (
      await tx.secret.findMany({
        where: { userId: scope.userId, spaceId: scope.spaceId, kind: spentKind },
        select: { id: true, createdAt: true },
      })
    )
      .filter((row) => row.id.startsWith(login))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  // How many of `rows` were asked for again: claimed within the window of the one after, back
  // from `until`.
  const asked = (rows: { createdAt: Date }[], until: number) => {
    let count = 0;
    for (const row of rows) {
      if (row.createdAt.getTime() > until) continue;
      if (until - row.createdAt.getTime() > LOGIN_CODE_REPEAT_WINDOW_MS) break;
      count += 1;
      until = row.createdAt.getTime();
    }
    return count;
  };
  // One claim or restore of this login at a time, across every run and process; an owner's save
  // of the login waits on the same row.
  const locked = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM vault_credentials WHERE id = ${input.login.id} FOR UPDATE`;
        return fn(tx);
      }),
    );
  // When this claim was written, so a stop set then is known as its own.
  let at: Date | undefined;
  const take = () =>
    locked(async (tx) => {
      const spent = await claimed(tx);
      const current = await tx.vaultCredential.findFirst({
        where: { id: input.login.id },
        select: { ciphertext: true, codesStoppedAt: true, updatedAt: true },
      });
      // The owner removed the login since this run read it.
      if (!current) return LOGIN_REMOVED;
      if (current.ciphertext !== input.login.ciphertext) return LOGIN_VALUE_CHANGED;
      // Another run stopped the login since this one read it.
      if (current.codesStoppedAt) return LOGIN_CODES_USED_UP;
      if (spent.some((row) => row.id === id)) return CODE_ALREADY_TYPED;
      at = new Date();
      const repeats = 1 + asked(spent, at.getTime());
      if (repeats > LOGIN_CODE_TRIES) return LOGIN_CODES_USED_UP;
      const stored = await input.secretStore.put(
        encodeRunCode(input.origin, input.code),
        { operationId: runId, traceId: runId, ...scope, signal: new AbortController().signal },
        { recordId: id, ephemeral: true },
      );
      await tx.secret.create({
        data: {
          id,
          userId: scope.userId,
          spaceId: scope.spaceId,
          kind: spentKind,
          ciphertext: stored.ciphertext,
          createdAt: at,
        },
      });
      // The last code a site keeps asking for stops the login, but only for the value it came
      // from: a key saved since may be right. The time it was saved stays, so an approval given
      // for it holds.
      if (repeats >= LOGIN_CODE_TRIES) {
        await tx.vaultCredential.updateMany({
          where: { id: input.login.id, ciphertext: current.ciphertext },
          data: { codesStoppedAt: at, updatedAt: current.updatedAt },
        });
      }
      return undefined;
    });
  return {
    claim: async (): Promise<string | undefined> => {
      try {
        return await take();
      } catch (error) {
        // The same code's row, written by a previous release's claim that takes no lock. Rows it
        // left stay in the database, so this goes only with a migration that settles them.
        if ((error as { code?: unknown } | null)?.code === "P2002") return CODE_ALREADY_TYPED;
        throw error;
      }
    },
    restore: async () => {
      await locked(async (tx) => {
        const { count } = await tx.secret.deleteMany({ where: { id, kind: spentKind } });
        if (!count) return;
        const current = await tx.vaultCredential.findFirst({
          where: { id: input.login.id },
          select: { codesStoppedAt: true, updatedAt: true },
        });
        const stop = current?.codesStoppedAt?.getTime();
        if (!stop) return;
        const rest = await claimed(tx);
        // Only a stop this run's codes of this value caused, by this claim or one still standing.
        const ours = stop === at?.getTime() || rest.some((row) => row.createdAt.getTime() === stop);
        if (ours && asked(rest, stop) < LOGIN_CODE_TRIES)
          await tx.vaultCredential.updateMany({
            where: { id: input.login.id, codesStoppedAt: current!.codesStoppedAt! },
            data: { codesStoppedAt: null, updatedAt: current!.updatedAt },
          });
      });
    },
  };
}
