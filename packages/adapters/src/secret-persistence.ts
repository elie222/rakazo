import { AsyncLocalStorage } from "node:async_hooks";
import type { JobPublisher, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystemInTransaction } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { SecretCleanup, SecretCleanupDeps } from "./secret-cleanup.js";
import {
  attemptSecretCleanup,
  cleanUpUnsavedSecret,
  finishSecretCleanup,
  paymentWalletRecordId,
  purchaseCardRecordId,
  purchaseRequestRecordId,
  purchaseTokenRecordId,
  recordSecretCleanups,
  runSecretCleanupsNow,
  secretCleanupJob,
  secretIsHeld,
} from "./secret-cleanup.js";

type Candidate = { id: string; ciphertext: string };
/**
 * `recorded` holds the cleanups whose backup job this transaction wrote, by reference, and
 * `queued` the references whose job is brought forward once it commits, instead of a direct
 * attempt.
 */
type Cleanup = {
  old: SecretCleanup[];
  written: Candidate[];
  recorded: Map<string, SecretCleanup>;
  queued: Set<string>;
  client?: Prisma.TransactionClient;
};
type Jobs = SecretCleanupDeps["jobs"] & Pick<JobPublisher, "enqueueManyIn">;
/** The queue that retries a failed delete, once the process has built it. */
export type SecretCleanupJobs = () => Jobs | undefined;
const cleanupJobs = new WeakMap<object, SecretCleanupJobs>();
/** More remote references than this in one drop are left to the queue rather than the caller. */
const DIRECT_CLEANUPS = 20;

/** Whether a mutation can leave a row without the reference it holds: a delete, or a new one. */
function dropsReference(operation: string, input: Mutation): boolean {
  if (operation.startsWith("create")) return false;
  if (operation.startsWith("delete")) return true;
  return [input.data, input.update]
    .flat()
    .some((value) => value !== undefined && "ciphertext" in value);
}

function cleanupOf(row: Candidate): SecretCleanup {
  return { kind: "secret_tables", recordId: row.id, ref: row.ciphertext };
}

type PurchaseRefs = {
  id: string;
  operationKey: string;
  cardCiphertext: string | null;
  requestCiphertext: string | null;
  tokenCiphertext: string | null;
};

function purchaseCleanups(row: PurchaseRefs): SecretCleanup[] {
  const held: Array<[SecretCleanup["kind"], string, string | null]> = [
    ["purchase_card", purchaseCardRecordId(row.id), row.cardCiphertext],
    ["purchase_request", purchaseRequestRecordId(row.operationKey), row.requestCiphertext],
    ["purchase_token", purchaseTokenRecordId(row.id), row.tokenCiphertext],
  ];
  return held.flatMap(([kind, recordId, ref]) => (ref ? [{ kind, recordId, ref }] : []));
}

/**
 * Deletes each entry no row of any Space holds. A remote entry's failed delete is retried by the
 * queue; without one, or for an inline reference, the same check runs and a failure is logged.
 */
async function deleteUnreferenced(
  prisma: SecretCleanupDeps["prisma"],
  store: SecretCleanupDeps["secrets"],
  jobs: Jobs | undefined,
  candidates: SecretCleanup[],
  recorded?: Map<string, SecretCleanup>,
): Promise<void> {
  for (const row of new Map(candidates.map((row) => [row.ref, row])).values()) {
    const cleanup = recorded?.get(row.ref) ?? row;
    if (!jobs || !store.isRemote(cleanup.ref)) {
      await bestEffort(
        "delete an unreferenced secret; nothing retries it",
        attemptSecretCleanup({ prisma, secrets: store }, cleanup),
      );
      continue;
    }
    const deps = { prisma, secrets: store, jobs };
    if (recorded?.has(cleanup.ref)) {
      await finishSecretCleanup(deps, cleanup);
      continue;
    }
    // A write its row holds needs no job at all, which is nearly every write.
    const held = await bestEffort(
      "check whether a written secret is held",
      secretIsHeld(deps, cleanup),
    );
    if (held) continue;
    // Not knowing is not "unheld": the job reads the rows again.
    if (held === undefined)
      await bestEffort("retry secret cleanup", jobs.enqueue(secretCleanupJob(cleanup)));
    else await cleanUpUnsavedSecret(deps, cleanup);
  }
}

// Prepared writes exist before the transaction starts. Defer its cleanup until
// the writer has adopted the committed ref (notably a live OAuth session).
const preparedWrite = new AsyncLocalStorage<{ cleanup: Array<() => Promise<void>> }>();
export async function persistPreparedSecret<T>(
  prisma: SecretCleanupDeps["prisma"],
  store: SecretCleanupDeps["secrets"],
  written: Candidate | undefined,
  commit: () => Promise<T>,
  adopted?: (result: T) => void,
): Promise<T> {
  const state = { cleanup: [] as Array<() => Promise<void>> };
  try {
    const result = await preparedWrite.run(state, commit);
    adopted?.(result);
    return result;
  } finally {
    for (const cleanup of state.cleanup) await cleanup();
    if (written)
      await deleteUnreferenced(prisma, store, cleanupJobs.get(prisma)?.(), [cleanupOf(written)]);
  }
}

type Mutation = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Array<Record<string, unknown>>;
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};
const secretTables = {
  Secret: "secrets",
  BotSecret: "bot_secrets",
  VaultCredential: "vault_credentials",
  IntegrationProviderConfig: "integration_provider_configs",
};
const parentTables = { User: "user", Space: "spaces", Bot: "bots", Organization: "organization" };
/** Tables whose rows go with a deleted parent and hold a reference of their own kind. */
const cascadedTables = {
  MessagingInstallation: "messaging_installations",
  PaymentWallet: "payment_wallets",
  Purchase: "purchases",
};

/** Cleanup is coordinated with the DB transaction, including parent cascades.
 * Credential mutations use interactive transactions; unrelated batch operations
 * retain their native behavior. Inline encrypted refs still notify consumers. */
export function withSecretPersistence(
  prisma: PrismaClient,
  store: SecretStore,
  jobs?: SecretCleanupJobs,
): PrismaClient {
  const transaction = new AsyncLocalStorage<Cleanup>();
  /** `committed` only after a commit: a rollback takes the backups with it. */
  async function cleanup(candidates: SecretCleanup[], committed?: Cleanup): Promise<void> {
    const run = async () => {
      const queue = jobs?.();
      if (queue && committed?.queued.size) {
        const due = [...committed.queued].map((ref) => committed.recorded.get(ref)!);
        // A failure leaves each backup to run at its own time.
        await bestEffort(
          "bring secret cleanups forward",
          runSecretCleanupsNow({ secrets: store, jobs: queue }, prisma, due),
        );
      }
      await deleteUnreferenced(prisma, store, queue, candidates, committed?.recorded);
    };
    const prepared = preparedWrite.getStore();
    if (prepared) prepared.cleanup.push(run);
    else await run();
  }
  /** Rows about to stop holding their refs, each with its backup job in the same transaction. */
  async function dropping(state: Cleanup, dropped: SecretCleanup[]): Promise<void> {
    const queue = jobs?.();
    if (!queue) {
      for (const cleanup of dropped) state.old.push(cleanup);
      return;
    }
    // One job stands for a reference however many of the rows share it.
    const fresh: SecretCleanup[] = [];
    for (const cleanup of dropped) {
      if (state.recorded.has(cleanup.ref)) continue;
      state.recorded.set(cleanup.ref, cleanup);
      fresh.push(cleanup);
    }
    const remote = fresh.filter((cleanup) => store.isRemote(cleanup.ref));
    await recordSecretCleanups({ secrets: store, jobs: queue }, state.client!, fresh);
    // A parent with a long history cascades to many entries: the worker deletes them once this
    // commits, so the caller does not wait on a remote delete for each.
    if (remote.length > DIRECT_CLEANUPS)
      for (const cleanup of remote) state.queued.add(cleanup.ref);
    for (const cleanup of dropped) if (!state.queued.has(cleanup.ref)) state.old.push(cleanup);
  }
  async function lockedRows<Row extends { id: string } = Candidate>(
    state: Cleanup,
    model: string,
    where?: Record<string, unknown>,
    columns = model in secretTables ? "id, ciphertext" : "id",
  ): Promise<Row[]> {
    const client = state.client!;
    const delegateName = model[0]!.toLowerCase() + model.slice(1);
    const delegate = Reflect.get(client, delegateName);
    const rows = (await Reflect.apply(delegate.findMany, delegate, [
      { where, select: { id: true } },
    ])) as Array<{ id: string }>;
    if (!rows.length) return [];
    const table =
      secretTables[model as keyof typeof secretTables] ??
      parentTables[model as keyof typeof parentTables] ??
      cascadedTables[model as keyof typeof cascadedTables];
    // Static table and column allowlists; the ids bind as one array, however many. Locks capture
    // the actual replaced ref even if another writer committed between selection and the lock.
    return client.$queryRaw<Row[]>(
      Prisma.sql`SELECT ${Prisma.raw(columns)} FROM ${Prisma.raw(`"${table}"`)} WHERE id = ANY(${rows.map((row) => row.id)}) ORDER BY id FOR UPDATE`,
    );
  }
  function trackWrites(state: Cleanup, model: string, input: Mutation): void {
    if (!(model in secretTables)) return;
    // Track new writes before DB access so even a pre-read failure can clean them.
    const data = [
      ...(Array.isArray(input.data) ? input.data : [input.data]),
      input.create,
      input.update,
    ];
    for (const value of data)
      if (typeof value?.ciphertext === "string") {
        const id = String(value.id ?? input.where?.id ?? "secret");
        state.written.push({
          id: model === "IntegrationProviderConfig" ? `integration-provider:${id}` : id,
          ciphertext: value.ciphertext,
        });
      }
  }
  async function prepare(
    state: Cleanup,
    model: string,
    operation: string,
    input: Mutation,
  ): Promise<void> {
    if (model in secretTables) {
      trackWrites(state, model, input);
      // A change that leaves the reference in place has nothing to clean up after it.
      if (dropsReference(operation, input)) {
        const old = await lockedRows(state, model, input.where);
        await dropping(
          state,
          old.map((row) =>
            cleanupOf(
              model === "IntegrationProviderConfig"
                ? { ...row, id: `integration-provider:${row.id}` }
                : row,
            ),
          ),
        );
      }
      return;
    }
    const parents = await lockedRows(state, model, input.where);
    if (!parents.length) return;
    // The cascade removes every member's rows under the parent, not only the ones the caller
    // may read, so their references are read across tenants. Only the references leave here.
    const cascaded = await runAsSystemInTransaction(
      state.client!,
      "clean up the secrets of rows a deleted parent cascades to",
      () => cascadedCleanups(state, model, parents),
    );
    await dropping(state, cascaded);
  }
  async function cascadedCleanups(
    state: Cleanup,
    model: string,
    parents: Array<{ id: string }>,
  ): Promise<SecretCleanup[]> {
    let filter: Record<string, unknown> = {
      [model === "User" ? "userId" : model === "Space" ? "spaceId" : "botId"]: {
        in: parents.map((row) => row.id),
      },
    };
    if (model === "Organization") {
      const spaces = await lockedRows(state, "Space", {
        organizationId: { in: parents.map((row) => row.id) },
      });
      filter = { spaceId: { in: spaces.map((row) => row.id) } };
    }
    const secretRows = async (table: string) =>
      (await lockedRows(state, table, filter)).map(cleanupOf);
    const cleanups: SecretCleanup[][] = [];
    if (model !== "Bot") {
      cleanups.push(await secretRows("Secret"), await secretRows("VaultCredential"));
    }
    cleanups.push(await secretRows("BotSecret"));
    const installs = await lockedRows(state, "MessagingInstallation", filter, "id, ciphertext");
    cleanups.push(
      installs.map((row) => ({
        kind: "messaging_installation" as const,
        recordId: row.id,
        ref: row.ciphertext,
      })),
    );
    if (model === "User") {
      const wallets = await lockedRows<Candidate & { userId: string }>(
        state,
        "PaymentWallet",
        filter,
        'id, "userId", ciphertext',
      );
      cleanups.push(
        wallets.map((row) => ({
          kind: "payment_wallet" as const,
          recordId: paymentWalletRecordId(row.userId),
          ref: row.ciphertext,
        })),
      );
    }
    // Purchases go with their Space only.
    if (model === "Space" || model === "Organization") {
      const purchases = await lockedRows<PurchaseRefs>(
        state,
        "Purchase",
        filter,
        'id, "operationKey", "cardCiphertext", "requestCiphertext", "tokenCiphertext"',
      );
      cleanups.push(purchases.flatMap(purchaseCleanups));
    }
    return cleanups.flat();
  }
  const extended = prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const relevant =
            (model in secretTables &&
              [
                "delete",
                "deleteMany",
                "update",
                "updateMany",
                "upsert",
                "create",
                "createMany",
              ].includes(operation)) ||
            (model in parentTables && ["delete", "deleteMany"].includes(operation));
          if (!relevant) return query(args);
          const active = transaction.getStore();
          if (active && !active.client) {
            trackWrites(active, model, args as Mutation);
            // A batch exposes no transaction client for locking and capture.
            // Fail before changing refs rather than break batch atomicity.
            throw new Error("Use an interactive transaction for secret persistence");
          }
          if (active?.client) {
            await prepare(active, model, operation, args as Mutation);
            return query(args);
          }
          const state: Cleanup = { old: [], written: [], recorded: new Map(), queued: new Set() };
          try {
            // Standalone mutations also need a transaction, so capture and replacement
            // share the same connection and row locks. No extra pool slot inside a tx.
            const result = await prisma.$transaction((tx) =>
              transaction.run(state, async () => {
                state.client = tx;
                await prepare(state, model, operation, args as Mutation);
                const delegate = Reflect.get(tx, model[0]!.toLowerCase() + model.slice(1));
                return Reflect.apply(delegate[operation], delegate, [args]);
              }),
            );
            await cleanup([...state.old, ...state.written.map(cleanupOf)], state);
            return result;
          } catch (error) {
            await cleanup(state.written.map(cleanupOf));
            throw error;
          }
        },
      },
    },
  });
  const persisted = new Proxy(extended, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        const callback =
          typeof args[0] === "function"
            ? (args[0] as (tx: Prisma.TransactionClient) => Promise<unknown>)
            : undefined;
        const state: Cleanup = { old: [], written: [], recorded: new Map(), queued: new Set() };
        if (callback)
          args[0] = (tx: Prisma.TransactionClient) => {
            state.client = tx;
            return callback(tx);
          };
        try {
          const result = await transaction.run(state, () =>
            Reflect.apply(target.$transaction, target, args),
          );
          await cleanup([...state.old, ...state.written.map(cleanupOf)], state);
          return result;
        } catch (error) {
          await cleanup(state.written.map(cleanupOf));
          throw error;
        }
      };
    },
  }) as unknown as PrismaClient;
  // Prepared writes are handed this client, which is how their cleanup finds the queue.
  if (jobs) cleanupJobs.set(persisted, jobs);
  return persisted;
}
