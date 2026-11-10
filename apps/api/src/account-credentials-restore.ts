import { randomBytes } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { AccountExportCredentials, AccountImportResult, Actor } from "@rakazo/contracts";
import { storedPiProviderIds } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, recordSecurityEvent, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { BackupCredentialsError, decryptBackupCredentials } from "./account-credentials-crypto.js";
import { nextConnectionLabel } from "./model-credentials.js";

export type AccountImportCredentialsResult = NonNullable<AccountImportResult["credentials"]>;

export type CredentialMappings = {
  /** Source space id to the new space the import created. */
  spaces: Map<string, string>;
  /** Source bot id to the new bot the import created. */
  bots: Map<string, string>;
};

type Counts = AccountImportCredentialsResult["restored"];

const zeroCounts = (): Counts => ({
  model: 0,
  voice: 0,
  connections: 0,
  mcp: 0,
  vault: 0,
  botSecrets: 0,
});

export type CredentialRestoreDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
};

function context(actor: Actor) {
  return {
    operationId: "account-import-credentials",
    traceId: "account-import-credentials",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  };
}

/**
 * The second phase of an account import, after the main import has finished. It never rolls
 * the import back: a wrong backup password, a tampered section, or a failed table only
 * skips credentials, and the result says so. Each table restores in its own serializable
 * transaction, so one table's failure does not take the others with it.
 *
 * Only creates, never overwrites. The dedup key per table:
 * - model: (userId, provider) — the same check `createImportedModelCredential` makes.
 * - voice: (userId, provider).
 * - connections: (spaceId, userId, connectorId, provider).
 * - mcp: (userId, spaceId, slug), or (userId, slug) among all-spaces servers.
 * - vault: (userId, spaceId, name) — the table's unique index.
 * - bot secrets: (userId, spaceId, botId, name) — the table's unique key.
 *
 * OAuth tokens are stored verbatim with no online check; the first refresh on the new
 * install fails naturally and marks the credential for reconnect. No new columns are added.
 */
export async function restoreAccountCredentials(
  deps: CredentialRestoreDeps,
  actor: Actor,
  encrypted: Uint8Array | null,
  password: Buffer | null,
  mappings: CredentialMappings,
): Promise<AccountImportCredentialsResult | undefined> {
  if (!encrypted) return undefined;
  const restored = zeroCounts();
  const skipped = zeroCounts();
  let error: string | undefined;
  if (!password) {
    error = "A backup password is required to restore the credentials in this export.";
  } else {
    let credentials: AccountExportCredentials | null = null;
    try {
      credentials = await decryptBackupCredentials({
        userId: actor.userId,
        password,
        encrypted: JSON.parse(new TextDecoder().decode(encrypted)),
      });
    } catch (thrown) {
      if (!(thrown instanceof BackupCredentialsError)) throw thrown;
      error = thrown.message;
    }
    if (credentials) {
      const tables: Array<() => Promise<void>> = [
        () => restoreModels(deps, actor, credentials.model, restored, skipped),
        () => restoreVoices(deps, actor, credentials.voice, restored, skipped),
        () => restoreConnections(deps, actor, credentials.connections, restored, skipped, mappings),
        () => restoreMcpServers(deps, actor, credentials.mcp, restored, skipped, mappings),
        () => restoreVault(deps, actor, credentials.vault, restored, skipped, mappings),
        () => restoreBotSecrets(deps, actor, credentials.botSecrets, restored, skipped, mappings),
      ];
      for (const restore of tables) {
        try {
          await restore();
        } catch (thrown) {
          // One table's failure must not take the others with it.
          getLogger().error("account.import.credentials_table_failed", thrown);
          error ??= "Some credentials could not be restored.";
        }
      }
    }
  }
  await recordSecurityEvent({
    type: "account.import.credentials",
    userId: actor.userId,
    metadata: {
      restored: Object.values(restored).reduce((sum, count) => sum + count, 0),
      failed: error !== undefined,
    },
  });
  return { restored, skipped, ...(error ? { error } : {}) };
}

/** Seals each plaintext before the transaction, like the interactive save path does. */
async function sealAll(
  deps: CredentialRestoreDeps,
  actor: Actor,
  items: Array<{ plaintext: string; recordId?: string }>,
): Promise<Array<{ id: string; ciphertext: string }>> {
  const sealed: Array<{ id: string; ciphertext: string }> = [];
  for (const item of items) {
    const stored = await deps.secrets.put(item.plaintext, context(actor), {
      ...(item.recordId ? { recordId: item.recordId } : {}),
    });
    sealed.push({ id: stored.id, ciphertext: stored.ciphertext });
  }
  return sealed;
}

async function restoreModels(
  deps: CredentialRestoreDeps,
  actor: Actor,
  items: AccountExportCredentials["model"],
  restored: Counts,
  skipped: Counts,
) {
  if (!items.length) return;
  const { userId } = actor;
  const sealed = await sealAll(deps, actor, items);
  await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const labels = (
          await tx.userModelCredential.findMany({ where: { userId }, select: { label: true } })
        ).map((row) => row.label);
        for (const [index, item] of items.entries()) {
          const existing = await tx.userModelCredential.findFirst({
            where: { userId, provider: { in: storedPiProviderIds(item.provider) } },
            select: { id: true },
          });
          if (existing) {
            skipped.model += 1;
            continue;
          }
          const secret = sealed[index]!;
          await tx.secret.create({
            data: {
              id: secret.id,
              userId,
              spaceId: null,
              kind: "model",
              ciphertext: secret.ciphertext,
            },
          });
          // Restores the connection, not its role: the importer chooses the main model.
          await tx.userModelCredential.create({
            data: {
              userId,
              provider: item.provider,
              label: nextConnectionLabel(item.label.trim() || item.provider, labels),
              secretId: secret.id,
              supportsImages: item.supportsImages,
            },
          });
          labels.push(item.label.trim() || item.provider);
          restored.model += 1;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function restoreVoices(
  deps: CredentialRestoreDeps,
  actor: Actor,
  items: AccountExportCredentials["voice"],
  restored: Counts,
  skipped: Counts,
) {
  if (!items.length) return;
  const { userId } = actor;
  const sealed = await sealAll(deps, actor, items);
  await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        for (const [index, item] of items.entries()) {
          const existing = await tx.userVoiceCredential.findFirst({
            where: { userId, provider: item.provider },
            select: { id: true },
          });
          if (existing) {
            skipped.voice += 1;
            continue;
          }
          const secret = sealed[index]!;
          await tx.secret.create({
            data: {
              id: secret.id,
              userId,
              spaceId: null,
              kind: "voice",
              ciphertext: secret.ciphertext,
            },
          });
          await tx.userVoiceCredential.create({
            data: { userId, provider: item.provider, secretId: secret.id },
          });
          restored.voice += 1;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function restoreConnections(
  deps: CredentialRestoreDeps,
  actor: Actor,
  items: AccountExportCredentials["connections"],
  restored: Counts,
  skipped: Counts,
  mappings: CredentialMappings,
) {
  if (!items.length) return;
  const { userId } = actor;
  const sealed = new Map<number, { id: string; ciphertext: string }>();
  for (const [index, item] of items.entries()) {
    if (item.plaintext === null) continue;
    const stored = await deps.secrets.put(item.plaintext, context(actor));
    sealed.set(index, { id: stored.id, ciphertext: stored.ciphertext });
  }
  await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        for (const [index, item] of items.entries()) {
          const spaceId = mappings.spaces.get(item.spaceId);
          if (!spaceId) {
            skipped.connections += 1;
            continue;
          }
          const existing = await tx.connection.findFirst({
            where: { spaceId, userId, connectorId: item.connectorId, provider: item.provider },
            select: { id: true },
          });
          if (existing) {
            skipped.connections += 1;
            continue;
          }
          const secret = sealed.get(index);
          if (secret)
            await tx.secret.create({
              data: {
                id: secret.id,
                userId,
                spaceId,
                kind: "connection",
                ciphertext: secret.ciphertext,
              },
            });
          await tx.connection.create({
            data: {
              spaceId,
              userId,
              connectorId: item.connectorId,
              provider: item.provider,
              displayName: item.displayName,
              status: item.status,
              secretId: secret?.id ?? null,
              providerRef: item.providerRef,
              metadata: item.metadata as Prisma.InputJsonValue,
            },
          });
          restored.connections += 1;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function restoreMcpServers(
  deps: CredentialRestoreDeps,
  actor: Actor,
  items: AccountExportCredentials["mcp"],
  restored: Counts,
  skipped: Counts,
  mappings: CredentialMappings,
) {
  if (!items.length) return;
  const { userId } = actor;
  const sealed = new Map<number, { id: string; ciphertext: string }>();
  for (const [index, item] of items.entries()) {
    if (item.material === null) continue;
    const stored = await deps.secrets.put(JSON.stringify(item.material), context(actor));
    sealed.set(index, { id: stored.id, ciphertext: stored.ciphertext });
  }
  await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        for (const [index, item] of items.entries()) {
          const spaceId = mappings.spaces.get(item.spaceId);
          if (!spaceId) {
            skipped.mcp += 1;
            continue;
          }
          const existing = await tx.mcpServer.findFirst({
            where: {
              userId,
              slug: item.slug,
              ...(item.allSpaces ? { allSpaces: true } : { spaceId }),
            },
            select: { id: true },
          });
          if (existing) {
            skipped.mcp += 1;
            continue;
          }
          const secret = sealed.get(index);
          if (secret)
            await tx.secret.create({
              data: {
                id: secret.id,
                userId,
                spaceId: item.allSpaces ? null : spaceId,
                kind: "mcp",
                ciphertext: secret.ciphertext,
              },
            });
          const material = (item.material ?? {}) as Record<string, unknown>;
          const keyMap = (value: unknown) =>
            (value && typeof value === "object" && !Array.isArray(value)
              ? Object.fromEntries(Object.keys(value).map((key) => [key, true]))
              : {}) as Prisma.InputJsonValue;
          await tx.mcpServer.create({
            data: {
              spaceId,
              userId,
              slug: item.slug,
              name: item.name,
              description: item.description,
              transport: item.transport,
              endpoint: item.endpoint,
              command: item.command,
              // Arguments live in the secret now; the column only says whether any exist.
              args: [] as Prisma.InputJsonValue,
              hasArgs: Array.isArray(material.args) && material.args.length > 0,
              env: keyMap(material.env),
              files: keyMap(material.files),
              headers: keyMap(material.headers),
              secretId: secret?.id ?? null,
              // The install the server came from is not in the backup.
              installId: null,
              enabled: item.enabled,
              verbatimResults: item.verbatimResults,
              allSpaces: item.allSpaces,
              allBots: item.allBots,
            },
          });
          restored.mcp += 1;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function restoreVault(
  deps: CredentialRestoreDeps,
  actor: Actor,
  items: AccountExportCredentials["vault"],
  restored: Counts,
  skipped: Counts,
  mappings: CredentialMappings,
) {
  if (!items.length) return;
  const { userId } = actor;
  // Vault rows seal under their own id, so the id is chosen before sealing.
  const prepared = items.map((item) => ({ item, id: randomBytes(12).toString("hex") }));
  const sealed = new Map<string, string>();
  for (const { item, id } of prepared) {
    const stored = await deps.secrets.put(item.plaintext, context(actor), { recordId: id });
    sealed.set(id, stored.ciphertext);
  }
  await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        for (const { item, id } of prepared) {
          const spaceId = item.spaceId === null ? null : mappings.spaces.get(item.spaceId);
          if (item.spaceId !== null && !spaceId) {
            skipped.vault += 1;
            continue;
          }
          const existing = await tx.vaultCredential.findFirst({
            where: { userId, spaceId, name: item.name },
            select: { id: true },
          });
          if (existing) {
            skipped.vault += 1;
            continue;
          }
          await tx.vaultCredential.create({
            data: {
              id,
              userId,
              spaceId,
              name: item.name,
              title: item.title,
              note: item.note,
              origin: item.origin,
              auth: item.auth as Prisma.InputJsonValue,
              ciphertext: sealed.get(id)!,
            },
          });
          restored.vault += 1;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function restoreBotSecrets(
  deps: CredentialRestoreDeps,
  actor: Actor,
  items: AccountExportCredentials["botSecrets"],
  restored: Counts,
  skipped: Counts,
  mappings: CredentialMappings,
) {
  if (!items.length) return;
  const { userId } = actor;
  const prepared = items.map((item) => ({ item, id: randomBytes(12).toString("hex") }));
  const sealed = new Map<string, string>();
  for (const { item, id } of prepared) {
    const stored = await deps.secrets.put(item.plaintext, context(actor), { recordId: id });
    sealed.set(id, stored.ciphertext);
  }
  await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        for (const { item, id } of prepared) {
          const spaceId = mappings.spaces.get(item.spaceId);
          const botId = mappings.bots.get(item.botId);
          if (!spaceId || !botId) {
            skipped.botSecrets += 1;
            continue;
          }
          const existing = await tx.botSecret.findFirst({
            where: { userId, spaceId, botId, name: item.name },
            select: { id: true },
          });
          if (existing) {
            skipped.botSecrets += 1;
            continue;
          }
          await tx.botSecret.create({
            data: {
              id,
              userId,
              spaceId,
              botId,
              name: item.name,
              origin: item.origin,
              auth: item.auth as Prisma.InputJsonValue,
              ciphertext: sealed.get(id)!,
            },
          });
          restored.botSecrets += 1;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
