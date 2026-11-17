import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** How often the reconciler lists the store; leftovers are rare and harmless for a while. */
const SWEEP_INTERVAL_MS = 60 * 60_000;
/** Older than any write whose transaction or prepared save could still be in flight. */
export const SECRET_SWEEP_GRACE_MS = 24 * 60 * 60_000;
/** Deletes per pass, so a mistake costs a bounded number of entries before it is noticed. */
const MAX_DELETES_PER_PASS = 100;
const REFS_PER_QUERY = 1_000;
const LIST_TIMEOUT_MS = 60_000;
const DELETE_TIMEOUT_MS = 10_000;

type Sweepable = Required<Pick<SecretStore, "listRemote" | "deleteListed">>;
type Column = { table: string; column: string };

function identifier(name: string) {
  return Prisma.raw(`"${name.replaceAll('"', '""')}"`);
}

/**
 * Every text column a reference can sit in: the store writes them into columns named for
 * ciphertext, so a new table that holds one is covered without a change here.
 */
async function holderColumns(prisma: Pick<PrismaClient, "$queryRaw">): Promise<Column[]> {
  return prisma.$queryRaw<Column[]>`
    SELECT table_name AS "table", column_name AS "column"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND column_name ILIKE '%cipher%'
      AND data_type IN ('text', 'character varying')
    ORDER BY table_name, column_name`;
}

/** The refs among `refs` that some row holds, read across every Space. */
export async function heldSecretRefs(
  prisma: Pick<PrismaClient, "$queryRaw">,
  refs: string[],
): Promise<Set<string>> {
  return runAsSystem("check which secret store entries rows still hold", async () => {
    const columns = await holderColumns(prisma);
    if (!columns.some(({ table, column }) => table === "secrets" && column === "ciphertext"))
      throw new Error("Secret holder columns are not readable");
    const held = new Set<string>();
    for (let start = 0; start < refs.length; start += REFS_PER_QUERY) {
      const batch = refs.slice(start, start + REFS_PER_QUERY);
      for (const { table, column } of columns) {
        const rows = await prisma.$queryRaw<Array<{ ref: string }>>(
          Prisma.sql`SELECT DISTINCT ${identifier(column)} AS ref FROM ${identifier(table)} WHERE ${identifier(column)} = ANY(${batch}::text[])`,
        );
        for (const { ref } of rows) held.add(ref);
      }
    }
    return held;
  });
}

/**
 * Removes store entries no row holds that are older than the grace period: writes whose save
 * never committed and deletes nothing retried. Fails closed: a read it cannot make, or a store
 * none of whose old entries any row holds, deletes nothing.
 */
export async function sweepSecretStore(
  prisma: Pick<PrismaClient, "$queryRaw">,
  store: Sweepable,
  now = Date.now(),
): Promise<number> {
  const listed = await store.listRemote(
    new Date(now - SECRET_SWEEP_GRACE_MS),
    AbortSignal.timeout(LIST_TIMEOUT_MS),
  );
  if (!listed.length) return 0;
  const held = await heldSecretRefs(prisma, listed);
  if (!held.size) {
    getLogger().warn("secret store sweep found no held entry; deleting nothing", {
      "secret.listed": listed.length,
    });
    return 0;
  }
  let removed = 0;
  for (const ref of listed) {
    if (held.has(ref)) continue;
    if (removed >= MAX_DELETES_PER_PASS) break;
    // Read again just before the delete, so a row saved since the first read keeps its entry.
    if ((await heldSecretRefs(prisma, [ref])).size) continue;
    await store.deleteListed(ref, AbortSignal.timeout(DELETE_TIMEOUT_MS));
    removed += 1;
  }
  return removed;
}

/** The worker reconciler's hourly pass, or nothing for a store without remote entries. */
export function secretStoreSweeper(
  prisma: Pick<PrismaClient, "$queryRaw">,
  store: SecretStore,
): (() => Promise<void>) | undefined {
  const { listRemote, deleteListed } = store;
  if (!listRemote || !deleteListed) return undefined;
  const sweepable: Sweepable = {
    listRemote: listRemote.bind(store),
    deleteListed: deleteListed.bind(store),
  };
  let last: number | undefined;
  return async () => {
    const now = Date.now();
    if (last !== undefined && now - last < SWEEP_INTERVAL_MS) return;
    last = now;
    const removed = await sweepSecretStore(prisma, sweepable, now);
    if (removed) getLogger().info("secret.store.swept", { "secret.removed": removed });
  };
}
