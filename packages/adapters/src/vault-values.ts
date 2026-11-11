import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { withAbort } from "@rakazo/core";
import type { ContentLocation, DataKey, PrismaClient } from "@rakazo/db";
import {
  CIPHERTEXT_PREFIX,
  ContentDecryptionError,
  ciphertextKeyId,
  contentEncryptionOf,
  decryptText,
  encryptText,
  VaultKeyOwnerGoneError,
} from "@rakazo/db";
import { INFISICAL_REF_PREFIX } from "./infisical-secret-store.js";

type VaultRow = { id: string; userId: string; spaceId: string | null };

// Vault keys sit beside the space keys under scopes no Space id can take: the account vault
// belongs to no Space, and a Space's content key exists long before `migrate` moves its vault.
const keyScope = (row: VaultRow) => (row.spaceId ? `vault:${row.spaceId}` : `user:${row.userId}`);
const location = (row: VaultRow): ContentLocation => ({
  table: "vault_credentials",
  column: "ciphertext",
  rowId: row.id,
  owner: row.userId,
});

function ringOf(prisma: PrismaClient) {
  const ring = contentEncryptionOf(prisma)?.ring;
  if (!ring) throw new Error("Vault item encryption is unavailable");
  return ring;
}

/**
 * A vault item's stored value: under its vault's data key once `content-encryption migrate` has
 * created one, as content is. Until then the secret store keeps writing the format the previous
 * release reads, since it keeps running for a while after a deploy. An external secret store
 * always keeps the value itself.
 */
export async function sealVaultValue(
  prisma: PrismaClient,
  store: SecretStore,
  row: VaultRow,
  plaintext: string,
  context: AdapterContext,
): Promise<string> {
  const ring = contentEncryptionOf(prisma)?.ring;
  if (ring?.encryptWrites && store.describe().id === "app-encrypted") {
    const key = (await ring.all(keyScope(row))).at(-1);
    if (key) return encryptText(key, location(row), plaintext);
  }
  return (await store.put(plaintext, context, { recordId: row.id })).ciphertext;
}

/** Reads both formats: values under a vault key, and those the secret store wrote before. */
export async function openVaultValue(
  prisma: PrismaClient,
  store: Pick<SecretStore, "load">,
  row: VaultRow & { ciphertext: string },
  signal?: AbortSignal,
): Promise<string> {
  if (!ciphertextKeyId(row.ciphertext))
    return store.load(row.ciphertext, signal ? { recordId: row.id, signal } : row.id);
  return openSealedVaultValue(prisma, row, signal);
}

/**
 * A value under its vault's key; it names that key, and only a key of the row's vault opens it.
 * A request's `signal` ends the key lookup at its deadline, since the key manager may hold it
 * open for longer; the read writes nothing, so a lookup left behind is harmless.
 */
export async function openSealedVaultValue(
  prisma: PrismaClient,
  row: VaultRow & { ciphertext: string },
  signal?: AbortSignal,
): Promise<string> {
  const keyId = ciphertextKeyId(row.ciphertext);
  if (!keyId) throw new ContentDecryptionError("Vault item is not under a vault key");
  const ring = ringOf(prisma);
  const lookup = ring.byId(keyId).catch(async (error: unknown) => {
    // A key its vault no longer has is damaged data, not a key manager outage; listing the
    // vault's keys fails in an outage too, which then stands. Listed from the store, since another
    // process may have just added the key.
    if (!(await ring.allFresh(keyScope(row))).some((stored) => stored.id === keyId))
      throw new ContentDecryptionError("Vault item names a key that no longer exists");
    throw error;
  });
  const key = await (signal ? withAbort(lookup, signal) : lookup);
  if (key.spaceId !== keyScope(row))
    throw new ContentDecryptionError("Vault item names another vault's key");
  return decryptText(key, location(row), row.ciphertext);
}

/**
 * Why an item could not be moved: the step that failed and the error's kind. Only a decryption
 * error's message is kept, since its text is fixed; other errors, from a secret store, a key
 * manager or the database, can quote the value or key material they were given.
 */
function failureReason(step: string, error: unknown) {
  if (error instanceof ContentDecryptionError) return `${step}: ${error.name}: ${error.message}`;
  const name = error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : "Error";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[\w.-]{1,40}$/.test(code)
    ? `${step}: ${name} (${code})`
    : `${step}: ${name}`;
}

/**
 * `encrypt` moves values the secret store wrote into the envelope format, creating each vault's
 * key, after which new saves in that vault use it too; `reencrypt` moves only items under an
 * older version of their vault's key to its newest, creating no key; `decrypt` writes them
 * back, before rolling back to a release that cannot read it. Each row is a compare-and-set on its
 * value and date, so a concurrent save wins; a row that cannot be read or verified stays as it
 * was and is reported with the reason, as is an item already under a vault key that does not
 * open. Values in an external store stay there. Safe to interrupt and rerun. Each vault's newest
 * key comes from the database, not this process's cache, since another process may have rotated it.
 */
export async function migrateVaultValues(
  prisma: PrismaClient,
  store: SecretStore,
  context: AdapterContext,
  options: {
    mode: "encrypt" | "reencrypt" | "decrypt";
    dryRun?: boolean;
    report?: (
      row: { id: string },
      status: "planned" | "migrated" | "concurrent" | "failed",
      reason?: string,
    ) => void;
  },
) {
  const counts = {
    migrated: 0,
    verified: 0,
    planned: 0,
    concurrent: 0,
    failed: 0,
    notMigrated: 0,
  };
  // Each vault's keys, read from the store once per batch rather than from this process's cache:
  // another process may have rotated a vault since, and items must move to its newest version.
  const fresh = new Map<string, Promise<DataKey[]>>();
  const keysOf = (scope: string) => {
    let keys = fresh.get(scope);
    if (!keys) {
      keys = ringOf(prisma).allFresh(scope);
      fresh.set(scope, keys);
    }
    return keys;
  };
  let cursor = "";
  while (true) {
    context.signal.throwIfAborted();
    fresh.clear();
    const batch = await prisma.vaultCredential.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: "asc" },
      take: 200,
      select: { id: true, userId: true, spaceId: true, ciphertext: true, updatedAt: true },
    });
    if (!batch.length) break;
    cursor = batch.at(-1)!.id;
    for (const row of batch) {
      // Each item may wait on the key manager, so an interruption stops before the next one.
      context.signal.throwIfAborted();
      const keyId = ciphertextKeyId(row.ciphertext);
      if (
        row.ciphertext.startsWith(INFISICAL_REF_PREFIX) ||
        (!keyId && options.mode === "decrypt")
      ) {
        counts.verified++;
        continue;
      }
      // Re-encryption moves only items already under a vault key. One in the previous format
      // stays as it is, readable by the previous release, until `migrate`, which alone creates a
      // vault's first key.
      if (!keyId && options.mode === "reencrypt") {
        counts.notMigrated++;
        continue;
      }
      let step = "read";
      let status: "migrated" | "concurrent" | "failed";
      try {
        const scope = keyScope(row);
        let newest = options.mode === "reencrypt" ? (await keysOf(scope)).at(-1) : undefined;
        if (keyId && keyId === newest?.id) {
          // Read again before calling it current: a rotation since the batch began must move it.
          fresh.delete(scope);
          newest = (await keysOf(scope)).at(-1);
        }
        if (keyId && (options.mode === "encrypt" || keyId === newest?.id)) {
          // Already under its vault's key (its newest, to re-encrypt): read, never rewritten, so
          // an unreadable item is reported.
          await openSealedVaultValue(prisma, row);
          counts.verified++;
          continue;
        }
        const plaintext = await openVaultValue(prisma, store, row, context.signal);
        // A preview reads each value but creates no key and writes nothing.
        if (options.dryRun) {
          counts.planned++;
          options.report?.(row, "planned");
          continue;
        }
        step = "write";
        let next: string;
        if (options.mode === "decrypt")
          next = (await store.put(plaintext, context, { recordId: row.id })).ciphertext;
        else if (options.mode === "encrypt") {
          const key = (await keysOf(scope)).at(-1) ?? (await ringOf(prisma).current(scope));
          next = encryptText(key, location(row), plaintext);
        }
        // Its vault's keys were deleted with its member or Space after the item was read.
        else if (!newest) throw new VaultKeyOwnerGoneError();
        else next = encryptText(newest, location(row), plaintext);
        step = "check";
        if ((await openVaultValue(prisma, store, { ...row, ciphertext: next })) !== plaintext)
          throw new ContentDecryptionError("Rewritten vault value did not round-trip");
        step = "save";
        const { count } = await prisma.vaultCredential.updateMany({
          where: { id: row.id, ciphertext: row.ciphertext, updatedAt: row.updatedAt },
          data: { ciphertext: next, updatedAt: row.updatedAt },
        });
        status = count === 1 ? "migrated" : "concurrent";
      } catch (error) {
        context.signal.throwIfAborted();
        // Its member or Space was deleted meanwhile, and the item with it.
        if (error instanceof VaultKeyOwnerGoneError) status = "concurrent";
        else {
          counts.failed++;
          options.report?.(row, "failed", failureReason(step, error));
          continue;
        }
      }
      counts[status]++;
      options.report?.(row, status);
    }
    if (batch.length < 200) break;
  }
  return counts;
}

/**
 * Vault items under a version of their vault's key other than the newest stored one, such as
 * saves a process sealed with the version it had cached when another process rotated the key.
 * `reencrypt` moves them. Read-only: it compares the key id each value names, opens nothing and
 * unwraps no key.
 */
export async function vaultItemsUnderOlderKeys(prisma: PrismaClient): Promise<number> {
  const newest = new Map<string, string>();
  for (const key of await prisma.spaceKey.findMany({
    where: { OR: [{ spaceId: { startsWith: "user:" } }, { spaceId: { startsWith: "vault:" } }] },
    orderBy: { version: "asc" },
    select: { id: true, spaceId: true, version: true },
  }))
    newest.set(key.spaceId, key.id);
  let count = 0;
  let cursor = "";
  while (true) {
    const batch = await prisma.vaultCredential.findMany({
      where: { id: { gt: cursor }, ciphertext: { startsWith: CIPHERTEXT_PREFIX } },
      orderBy: { id: "asc" },
      take: 1000,
      select: { id: true, userId: true, spaceId: true, ciphertext: true },
    });
    for (const row of batch)
      if (ciphertextKeyId(row.ciphertext) !== newest.get(keyScope(row))) count++;
    if (batch.length < 1000) return count;
    cursor = batch.at(-1)!.id;
  }
}

/**
 * Adds a new version to every vault key, members' and Spaces' own alike, for
 * `rotate --reencrypt`; `reencrypt` then moves items to it. Older versions keep opening.
 * A key whose member or Space was deleted meanwhile has nothing left to protect and is skipped;
 * a key that fails to rotate is reported, and the rest still rotate.
 */
export async function rotateVaultKeys(
  prisma: PrismaClient,
  options: {
    signal?: AbortSignal;
    report?: (scope: string, status: "owner gone" | "failed", reason?: string) => void;
  } = {},
) {
  const ring = ringOf(prisma);
  const counts = { rotated: 0, ownerGone: 0, failed: 0 };
  let cursor = "";
  while (true) {
    options.signal?.throwIfAborted();
    const scopes = await prisma.spaceKey.groupBy({
      by: ["spaceId"],
      where: {
        spaceId: { gt: cursor },
        OR: [{ spaceId: { startsWith: "user:" } }, { spaceId: { startsWith: "vault:" } }],
      },
      orderBy: { spaceId: "asc" },
      take: 200,
    });
    if (!scopes.length) break;
    cursor = scopes.at(-1)!.spaceId;
    for (const { spaceId } of scopes) {
      options.signal?.throwIfAborted();
      try {
        await ring.rotate(spaceId);
        counts.rotated++;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof VaultKeyOwnerGoneError) {
          counts.ownerGone++;
          options.report?.(spaceId, "owner gone");
        } else {
          counts.failed++;
          options.report?.(spaceId, "failed", failureReason("rotate", error));
        }
      }
    }
    if (scopes.length < 200) break;
  }
  return counts;
}
