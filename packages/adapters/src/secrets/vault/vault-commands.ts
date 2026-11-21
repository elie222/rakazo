import type { SecretStore } from "@rakazo/adapter-kit";
import type { BotSecretDestination } from "@rakazo/contracts";
import { commandVariableName, commandVariableProblem } from "@rakazo/contracts";
import { mapConcurrent } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { isCommandCredential } from "../bot-secret-destination.js";
import type { BotSecretScope, VaultItemUse } from "./vault-access.js";
import {
  hiddenFromBot,
  usableVaultFields,
  VAULT_UNLOCK_CONCURRENCY,
  vaultFields,
} from "./vault-access.js";
import {
  commandRedactionForms,
  openForRedaction,
  VaultKeyUnavailableError,
} from "./vault-redaction.js";
import type { openVaultValue } from "./vault-values.js";

const commandRowFields = {
  userId: true,
  id: true,
  name: true,
  spaceId: true,
  auth: true,
  ciphertext: true,
} as const;

/** Each command variable of these rows, decrypted once; one that can't be read has no value. */
async function readCommandVariables(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  rows: (Parameters<typeof openVaultValue>[2] & { name: string; auth: unknown })[],
  keyOutage: "throw" | "unset",
) {
  const commands = rows.flatMap((row) => {
    if (!isCommandCredential(row.auth)) return [];
    const variable = commandVariableName(row.name);
    if (commandVariableProblem(variable)) return [];
    return [{ row, variable }];
  });
  return mapConcurrent(
    commands,
    VAULT_UNLOCK_CONCURRENCY,
    async ({
      row,
      variable,
    }): Promise<{ item: VaultItemUse; variable: string; value?: string }> => {
      const item = { id: row.id, name: row.name, spaceId: row.spaceId, kind: "command" };
      try {
        return { item, variable, value: await openForRedaction(prisma, secretStore, row) };
      } catch (error) {
        if (error instanceof VaultKeyUnavailableError && keyOutage === "throw") throw error;
        // One unreadable value must not stop every shell command; the variable is left unset.
        return { item, variable };
      }
    },
  );
}

/** What a command gets: its variables, and the items they came from, without their values. */
function commandEnvironment(
  variables: { item: VaultItemUse; variable: string; value?: string }[],
  unsetVariables?: Set<string>,
): { env: Record<string, string>; used: VaultItemUse[] } {
  const env: Record<string, string> = {};
  const from = new Map<string, VaultItemUse>();
  for (const { item, variable, value } of variables) {
    if (value === undefined) unsetVariables?.add(variable);
    else if (value && !value.includes("\0")) {
      env[variable] = value;
      from.set(variable, item);
    }
  }
  return { env, used: [...from.values()] };
}

/**
 * This bot's command variables, and the values to redact: also those it may no longer use, as
 * an earlier run may have written one out. A value is exported only from the read that found the
 * bot may use it, so an item replaced and blocked between the two reads never leaks its new value.
 * Each stored value is decrypted once. The values must never be logged or returned; callers
 * register the redactions before a command runs. `used` names the items whose values are in
 * `env`, from that same read and without the values, for the caller to record once a command has
 * them: loading alone, as a run does at its start to hide the values, is no use.
 */
export async function loadCommandVariables(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  unsetVariables?: Set<string>,
  keyOutage: "throw" | "unset" = "throw",
): Promise<{ env: Record<string, string>; used: VaultItemUse[]; redactions: string[] }> {
  const { botId: _, ...owner } = scope;
  const [usable, rows] = await Promise.all([
    prisma.vaultCredential.findMany({
      where: await usableVaultFields(prisma, scope),
      select: commandRowFields,
      orderBy: { name: "asc" },
    }),
    prisma.vaultCredential.findMany({
      where: await vaultFields(prisma, owner),
      select: commandRowFields,
      orderBy: { name: "asc" },
    }),
  ]);
  const read = new Set(usable.map((row) => `${row.id}\0${row.ciphertext}`));
  const exported = await readCommandVariables(prisma, secretStore, usable, keyOutage);
  const others = await readCommandVariables(
    prisma,
    secretStore,
    rows.filter((row) => !read.has(`${row.id}\0${row.ciphertext}`)),
    keyOutage,
  );
  return {
    ...commandEnvironment(exported, unsetVariables),
    // Encoded forms too, as secret_request does, so an accidental `base64` or URL-encoding of a
    // value is still redacted from command output.
    // Every value, not one per variable: an item's old and new value share its variable.
    redactions: [
      ...new Set(
        [...exported, ...others].flatMap(({ value }) =>
          value && !value.includes("\0") ? commandRedactionForms(value) : [],
        ),
      ),
    ],
  };
}

/**
 * The environment for one shell command: the command variables of the vault this Space uses,
 * loaded fresh. The values are handed to `registerRedactions` before this returns, so the
 * command's output is redacted. The caller records `used` once the command is sent with them.
 */
export async function shellCommandEnvironment(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  scope: BotSecretScope;
  registerRedactions: (values: string[]) => void;
  keyOutage?: "throw" | "unset";
}): Promise<{ env: Record<string, string>; unsetEnv: string[]; used: VaultItemUse[] }> {
  const unsetVariables = new Set<string>();
  const { env, used, redactions } = await loadCommandVariables(
    input.prisma,
    input.secretStore,
    input.scope,
    unsetVariables,
    input.keyOutage,
  );
  input.registerRedactions(redactions);
  return { env, unsetEnv: [...unsetVariables], used };
}

/** Another command credential of this bot that is exported as the same variable. */
export async function findCommandVariableConflict(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  destination: BotSecretDestination,
): Promise<string | undefined> {
  if (destination.auth.type !== "command") return undefined;
  const variable = commandVariableName(destination.name);
  const rows = await client.vaultCredential.findMany({
    where: { ...(await vaultFields(client, scope)), name: { not: destination.name } },
    select: { name: true, auth: true },
  });
  const name = rows.find(
    (row) => isCommandCredential(row.auth) && commandVariableName(row.name) === variable,
  )?.name;
  // A bot is never told the name of an item it can't see.
  return name && (await hiddenFromBot(client, scope, name)) ? "another saved item" : name;
}
