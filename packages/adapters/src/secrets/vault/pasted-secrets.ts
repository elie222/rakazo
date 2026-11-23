import { randomBytes } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import { commandVariableName } from "@rakazo/contracts";
import type { TextRange } from "@rakazo/core";
import { ClientError, credentialMatches, joinRanges } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { TransactionConflictError } from "@rakazo/db";
import { persistPreparedSecret } from "../secret-persistence.js";
import { isSecretAlreadySaved, VAULT_CHANGED, vaultFields } from "./vault-access.js";
import { loadCommandVariables } from "./vault-commands.js";
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
 * the value is never kept in the conversation or sent to the model. A value already saved as a
 * command variable keeps that name, even where bots are blocked from it: a copy would undo the
 * owner's choice in every Space sharing the vault. A new one is `PASTED_KEY_` and a random
 * suffix, so in a group chat its placeholder never names another member's item.
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
  const { env } = await loadCommandVariables(prisma, secretStore, scope);
  const variables = new Map(Object.entries(env).map(([variable, value]) => [value, variable]));
  const taken = new Set(
    (
      await prisma.vaultCredential.findMany({
        where: await vaultFields(prisma, scope),
        select: { name: true },
      })
    ).map((row) => commandVariableName(row.name)),
  );
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
    for (const value of values) {
      if (variables.has(value)) continue;
      let name: string;
      do name = `${PASTED_NAME}-${randomBytes(3).toString("hex")}`;
      while (taken.has(commandVariableName(name)));
      const variable = commandVariableName(name);
      taken.add(variable);
      variables.set(value, variable);
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
    text: swapRanges(text, ranges, (value) => variables.get(value) ?? ""),
    async store(tx) {
      for (const item of prepared) await item.store(tx).catch(conflict);
    },
    persist,
  };
}
