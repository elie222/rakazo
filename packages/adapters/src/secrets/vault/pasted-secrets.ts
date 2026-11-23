import type { SecretStore } from "@rakazo/adapter-kit";
import { commandVariableName } from "@rakazo/contracts";
import { credentialRanges, joinRanges } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { TransactionConflictError } from "@rakazo/db";
import { persistPreparedSecret } from "../secret-persistence.js";
import { isSecretAlreadySaved, VAULT_CHANGED, vaultFields } from "./vault-access.js";
import { loadCommandVariables } from "./vault-commands.js";
import { prepareBotSecret } from "./vault-save.js";

const PASTED_NAME = "pasted-key";

/** Each credential-shaped value, and every other place the same value appears, in order. */
function pastedRanges(text: string) {
  const found = credentialRanges(text);
  const ranges = [...found];
  for (const value of new Set(found.map(({ start, end }) => text.slice(start, end)))) {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length))
      ranges.push({ start: at, end: at + value.length });
  }
  return joinRanges(ranges);
}

/** The text with each pasted value swapped for the variable it is saved as. */
export function swapPastedValues(text: string, variableOf: (value: string) => string): string {
  let swapped = "";
  let at = 0;
  for (const { start, end } of pastedRanges(text)) {
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
 * command variable keeps that name; a new one is `PASTED_KEY`, then `PASTED_KEY_2`, and so on.
 */
export async function preparePastedSecrets(
  deps: { prisma: PrismaClient; secretStore: SecretStore },
  author: { userId: string; spaceId: string },
  text: string | undefined,
): Promise<PastedSecrets> {
  const values = new Set(
    pastedRanges(text ?? "").map(({ start, end }) => text?.slice(start, end) ?? ""),
  );
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
      let name = PASTED_NAME;
      for (let suffix = 2; taken.has(commandVariableName(name)); suffix++)
        name = `${PASTED_NAME}-${suffix}`;
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
    text: swapPastedValues(text, (value) => variables.get(value) ?? PASTED_NAME),
    async store(tx) {
      for (const item of prepared) await item.store(tx).catch(conflict);
    },
    persist,
  };
}
