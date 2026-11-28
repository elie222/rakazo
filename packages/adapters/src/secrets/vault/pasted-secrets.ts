import { randomBytes } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import { commandVariableName, THREAD_MESSAGE_TEXT_MAX_LENGTH } from "@rakazo/contracts";
import type { TextRange } from "@rakazo/core";
import { ClientError, credentialMatches, joinRanges } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { TransactionConflictError } from "@rakazo/db";
import { persistPreparedSecret } from "../secret-persistence.js";
import { isSecretAlreadySaved, VAULT_CHANGED, vaultFields } from "./vault-access.js";
import { prepareBotSecret } from "./vault-save.js";

const PASTED_NAME = "pasted-key";
/** The most keys one message may hold; a message with more is refused, so none is kept. */
export const MAX_PASTED_KEYS = 10;

export class TooManyPastedKeysError extends ClientError {
  constructor() {
    super(
      "BAD_REQUEST",
      `A message can hold at most ${MAX_PASTED_KEYS} keys. Send the rest in another message.`,
      "TOO_MANY_PASTED_KEYS",
    );
    this.name = "TooManyPastedKeysError";
  }
}

export class PastedMessageTooLongError extends ClientError {
  constructor() {
    super(
      "BAD_REQUEST",
      "This message is too long once its keys are saved. Send a shorter one.",
      "PASTED_MESSAGE_TOO_LONG",
    );
    this.name = "PastedMessageTooLongError";
  }
}

/**
 * Each credential-shaped value, and every other place one of its matches appears, in order.
 * The cap keeps the search for repeats to a few passes over the text.
 */
function pastedRanges(text: string) {
  const found = credentialMatches(text);
  const matched = new Set(found.map(({ start, end }) => text.slice(start, end)));
  if (matched.size > MAX_PASTED_KEYS) throw new TooManyPastedKeysError();
  const ranges = [...found];
  for (const value of matched) {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length))
      ranges.push({ start: at, end: at + value.length });
  }
  const joined = joinRanges(ranges);
  if (new Set(joined.map(({ start, end }) => text.slice(start, end))).size > MAX_PASTED_KEYS)
    throw new TooManyPastedKeysError();
  return joined;
}

/** The text with each pasted value swapped for the variable it is saved as. */
export function swapPastedValues(text: string, variableOf: (value: string) => string): string {
  return swapRanges(text, pastedRanges(text), variableOf);
}

function swapRanges(
  text: string,
  ranges: readonly TextRange[],
  variableOf: (value: string) => string,
): string {
  let swapped = "";
  let at = 0;
  for (const { start, end } of ranges) {
    swapped += `${text.slice(at, start)}[saved as $${variableOf(text.slice(start, end))}]`;
    at = end;
  }
  return swapped + text.slice(at);
}

export type PastedSecrets = {
  /** What is stored, indexed and sent to the model in place of the text the member wrote. */
  text: string | undefined;
  /** Saves the new vault items, in the transaction that writes the message. */
  store(tx: Prisma.TransactionClient): Promise<void>;
  /** Runs the send so a stored value its failed transaction leaves behind is deleted. */
  persist<T>(commit: () => Promise<T>): Promise<T>;
};

/**
 * Moves each key a member pasted into a chat message to their vault as a command variable, so
 * the value is never kept in the conversation or sent to the model. Each is saved as `PASTED_KEY_`
 * and a random suffix, even a value already saved: another member's run resolves a name in their
 * own vault, and any chat can gain members, so a name the author already uses could give that run
 * their different item.
 */
export async function preparePastedSecrets(
  deps: { prisma: PrismaClient; secretStore: SecretStore },
  author: { userId: string; spaceId: string },
  text: string | undefined,
): Promise<PastedSecrets> {
  const ranges = pastedRanges(text ?? "");
  const values = new Set(ranges.map(({ start, end }) => text?.slice(start, end) ?? ""));
  if (!text || !values.size) return { text, store: async () => {}, persist: (commit) => commit() };
  const { prisma, secretStore } = deps;
  const scope = { userId: author.userId, spaceId: author.spaceId };
  const names = new Map<string, string>();
  const taken = new Set(
    (
      await prisma.vaultCredential.findMany({
        where: await vaultFields(prisma, scope),
        select: { name: true },
      })
    ).map((row) => commandVariableName(row.name)),
  );
  for (const value of values) {
    let name: string;
    do name = `${PASTED_NAME}-${randomBytes(3).toString("hex")}`;
    while (taken.has(commandVariableName(name)));
    taken.add(commandVariableName(name));
    names.set(value, name);
  }
  // A placeholder is longer than a short key, so many repeats of one can outgrow the cap.
  const swapped = swapRanges(text, ranges, (value) => commandVariableName(names.get(value) ?? ""));
  if (swapped.length > THREAD_MESSAGE_TEXT_MAX_LENGTH) throw new PastedMessageTooLongError();
  const prepared: Awaited<ReturnType<typeof prepareBotSecret>>[] = [];
  // Another send took the name first. This one fails as a conflict; sent again, it picks another.
  const conflict = (error: unknown) => {
    throw isSecretAlreadySaved(error) ? new TransactionConflictError(VAULT_CHANGED) : error;
  };
  const persist = <T>(commit: () => Promise<T>) =>
    prepared.reduceRight(
      (inner, item) => () => persistPreparedSecret(prisma, secretStore, item, inner),
      commit,
    )();
  try {
    for (const [value, name] of names) {
      prepared.push(
        await prepareBotSecret({
          prisma,
          secretStore,
          scope,
          destination: { name, origin: "", auth: { type: "command" } },
          plaintext: value,
          createOnly: true,
        }).catch(conflict),
      );
    }
  } catch (error) {
    // The values already stored for this message are deleted with it.
    return persist(() => Promise.reject(error));
  }
  return {
    text: swapped,
    async store(tx) {
      for (const item of prepared) await item.store(tx).catch(conflict);
    },
    persist,
  };
}
