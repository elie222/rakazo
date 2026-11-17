import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AdapterContext,
  BackgroundJob,
  BackgroundJobPayloads,
  JobPublisher,
  JobTransaction,
  SecretCleanupKind,
  SecretPutOptions,
  SecretStore,
} from "@rakazo/adapter-kit";
import { SecretNotFoundError } from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { credentialDigest } from "./credential-digest.js";
import holderColumns from "./secret-holder-columns.json" with { type: "json" };

export type SecretCleanup = BackgroundJobPayloads["secret.cleanup"];

export interface SecretCleanupDeps {
  prisma: Pick<
    PrismaClient,
    | "secret"
    | "botSecret"
    | "vaultCredential"
    | "integrationProviderConfig"
    | "messagingInstallation"
    | "deploymentSettings"
    | "purchase"
    | "paymentWallet"
    | "$queryRaw"
  >;
  secrets: Pick<SecretStore, "delete" | "isRemote">;
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn" | "cancel" | "cancelIn">;
}

const ATTEMPT_MS = 10_000;
const BACKUP_MS = ATTEMPT_MS + 5_000;
/** How long a store write may take before it is abandoned. */
const STORE_WRITE_MS = 30_000;
/**
 * A written entry's backup runs this long after the write's own deadline. The row that will hold
 * it is saved in this time: some saves wait on a provider's answer or a 60-second transaction
 * first, and a backup that ran before the save would delete an entry about to be held.
 */
const SAVE_MARGIN_MS = 5 * 60_000;
/**
 * How long a provider call between a remote write and its row's save may take, leaving the rest
 * of the margin for the store write and a 60-second transaction before the save.
 */
export const PROVIDER_BEFORE_SAVE_MS = SAVE_MARGIN_MS / 2;
const PURCHASE_REQUEST_RECORD = "purchase-request:";
const PURCHASE_CARD_RECORD = "purchase-card:";
const PURCHASE_TOKEN_RECORD = "purchase-token:";
const PAYMENT_WALLET_RECORD = "payment-wallet:";

export function purchaseRequestRecordId(operationKey: string): string {
  return PURCHASE_REQUEST_RECORD + operationKey;
}

export function purchaseCardRecordId(purchaseId: string): string {
  return PURCHASE_CARD_RECORD + purchaseId;
}

export function purchaseTokenRecordId(purchaseId: string): string {
  return PURCHASE_TOKEN_RECORD + purchaseId;
}

export function paymentWalletRecordId(userId: string): string {
  return PAYMENT_WALLET_RECORD + userId;
}

type Holders = SecretCleanupDeps["prisma"];

/** Whether any row of the four secret tables, in any Space, holds the reference. */
async function secretTablesHold(prisma: Holders, ref: string): Promise<boolean> {
  const where = { ciphertext: ref };
  return Boolean(
    (await prisma.secret.count({ where })) ||
      (await prisma.botSecret.count({ where })) ||
      (await prisma.vaultCredential.count({ where })) ||
      (await prisma.integrationProviderConfig.count({ where })),
  );
}

/** One lookup per `checked` column in secret-holder-columns.json, quoted from that fixed list. */
const HOLDER_COLUMNS = holderColumns.checked.map((name) => {
  const [table, column, extra] = name.split(".");
  if (!table || !column || extra !== undefined || !/^\w+$/.test(table) || !/^\w+$/.test(column))
    throw new Error(`secret-holder-columns.json lists an invalid column: ${name}`);
  return { table: Prisma.raw(`"${table}"`), column: Prisma.raw(`"${column}"`) };
});

/** Whether any column a reference can be saved in holds it, in one query. */
async function anyRecordHolds(prisma: Holders, ref: string): Promise<boolean> {
  const lookups = HOLDER_COLUMNS.map(
    ({ table, column }) => Prisma.sql`EXISTS (SELECT 1 FROM ${table} WHERE ${column} = ${ref})`,
  );
  const [row] = await prisma.$queryRaw<Array<{ held: boolean }>>(
    Prisma.sql`SELECT ${Prisma.join(lookups, " OR ")} AS held`,
  );
  return row?.held === true;
}

/** The reference each kind of record holds now, which a cleanup must never delete. */
const heldRef: Record<
  SecretCleanupKind,
  (prisma: Holders, recordId: string, ref: string) => Promise<string | null | undefined>
> = {
  secret_row: async (prisma, id) =>
    (await prisma.secret.findUnique({ where: { id }, select: { ciphertext: true } }))?.ciphertext,
  // Rows of these tables can share one reference, so any of them holding it counts.
  secret_tables: async (prisma, _recordId, ref) =>
    (await secretTablesHold(prisma, ref)) ? ref : null,
  // Written before its record was known, so a record of any kind may hold it.
  store_write: async (prisma, _recordId, ref) => ((await anyRecordHolds(prisma, ref)) ? ref : null),
  messaging_installation: async (prisma, id) =>
    (await prisma.messagingInstallation.findUnique({ where: { id }, select: { ciphertext: true } }))
      ?.ciphertext,
  deployment_computer_provider: async (prisma) =>
    (
      await prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { computerProviderCipher: true },
      })
    )?.computerProviderCipher,
  purchase_request: async (prisma, recordId) =>
    (
      await prisma.purchase.findUnique({
        where: { operationKey: recordId.slice(PURCHASE_REQUEST_RECORD.length) },
        select: { requestCiphertext: true },
      })
    )?.requestCiphertext,
  purchase_card: async (prisma, recordId) =>
    (
      await prisma.purchase.findUnique({
        where: { id: recordId.slice(PURCHASE_CARD_RECORD.length) },
        select: { cardCiphertext: true },
      })
    )?.cardCiphertext,
  purchase_token: async (prisma, recordId) =>
    (
      await prisma.purchase.findUnique({
        where: { id: recordId.slice(PURCHASE_TOKEN_RECORD.length) },
        select: { tokenCiphertext: true },
      })
    )?.tokenCiphertext,
  payment_wallet: async (prisma, recordId) =>
    (
      await prisma.paymentWallet.findUnique({
        where: { userId: recordId.slice(PAYMENT_WALLET_RECORD.length) },
        select: { ciphertext: true },
      })
    )?.ciphertext,
};

/** Keyed by a digest, so the queue's own key never carries the reference. */
export function secretCleanupJobKey(ref: string): string {
  return `secret.cleanup:${credentialDigest(ref)}`;
}

/** Without `availableAt` it runs now, which is how a failed direct attempt hands over. */
export function secretCleanupJob(cleanup: SecretCleanup, availableAt?: Date): BackgroundJob {
  return {
    name: "secret.cleanup",
    payload: cleanup,
    ...(availableAt ? { availableAt } : {}),
    replaceKey: secretCleanupJobKey(cleanup.ref),
    maxAttempts: 20,
  };
}

function backupJob(cleanup: SecretCleanup): BackgroundJob {
  return secretCleanupJob(cleanup, new Date(Date.now() + BACKUP_MS));
}

/** Kinds whose reference several records can hold, so one job key can stand for several drops. */
const SHARED_REFERENCE_KINDS: ReadonlySet<SecretCleanupKind> = new Set(["secret_tables"]);

/** Whether a record holds the reference now, read as the system so every Space's rows count. */
export async function secretIsHeld(
  deps: Pick<SecretCleanupDeps, "prisma">,
  { kind, recordId, ref }: SecretCleanup,
): Promise<boolean> {
  const held = await runAsSystem("check that nothing refers to a secret before deleting it", () =>
    heldRef[kind](deps.prisma, recordId, ref),
  );
  return held === ref;
}

/**
 * Deletes a store entry unless its record refers to it again. The direct attempt and the job
 * share this, so neither deletes a reference a later write brought back into use.
 */
async function deleteUnreferencedSecret(
  deps: Pick<SecretCleanupDeps, "prisma" | "secrets">,
  cleanup: SecretCleanup,
): Promise<"held" | "done"> {
  if (await secretIsHeld(deps, cleanup)) return "held";
  const { kind, recordId, ref } = cleanup;
  try {
    await deps.secrets.delete(ref, { recordId, signal: AbortSignal.timeout(ATTEMPT_MS) });
  } catch (error) {
    if (!(error instanceof SecretNotFoundError)) throw error;
    // A store can keep an entry under the record that wrote it. Another record's attempt is
    // refused the same way every time, so retrying it only repeats the refusal.
    getLogger().warn("secret cleanup cannot reach the entry under this record", {
      "secret.kind": kind,
    });
  }
  return "done";
}

/**
 * In the transaction that stops referring to a secret: the backup that deletes its store entry
 * if this process never does. Only a remote entry needs one. An inline reference is the sealed
 * value itself, which goes with its row and must not be copied into a job.
 */
export async function recordSecretCleanup(
  deps: Pick<SecretCleanupDeps, "secrets" | "jobs">,
  tx: JobTransaction,
  cleanup: SecretCleanup,
): Promise<void> {
  if (deps.secrets.isRemote(cleanup.ref)) await deps.jobs.enqueueIn(tx, backupJob(cleanup));
}

/** `recordSecretCleanup` for many references in one statement. */
export async function recordSecretCleanups(
  deps: Pick<SecretCleanupDeps, "secrets"> & { jobs: Pick<JobPublisher, "enqueueManyIn"> },
  tx: JobTransaction,
  cleanups: SecretCleanup[],
): Promise<void> {
  await enqueueCleanups(deps, tx, cleanups, backupJob);
}

/**
 * After that transaction commits: brings their backups forward to now in one statement, so the
 * worker deletes them and the caller never waits on one remote delete per reference. Run before
 * the commit, a job could find the reference still held and finish without deleting it.
 */
export async function runSecretCleanupsNow(
  deps: Pick<SecretCleanupDeps, "secrets"> & { jobs: Pick<JobPublisher, "enqueueManyIn"> },
  db: JobTransaction,
  cleanups: SecretCleanup[],
): Promise<void> {
  await enqueueCleanups(deps, db, cleanups, (cleanup) => secretCleanupJob(cleanup));
}

async function enqueueCleanups(
  deps: Pick<SecretCleanupDeps, "secrets"> & { jobs: Pick<JobPublisher, "enqueueManyIn"> },
  db: JobTransaction,
  cleanups: SecretCleanup[],
  job: (cleanup: SecretCleanup) => BackgroundJob,
): Promise<void> {
  const jobs = cleanups.filter((cleanup) => deps.secrets.isRemote(cleanup.ref)).map(job);
  if (jobs.length) await deps.jobs.enqueueManyIn(db, jobs);
}

/**
 * After that transaction commits: delete the entry now. Success deletes the backup; a failure is
 * logged and handed to it. Never rejects, so cleanup cannot change the caller's outcome.
 */
export async function finishSecretCleanup(
  deps: SecretCleanupDeps,
  cleanup: SecretCleanup,
): Promise<void> {
  if (!deps.secrets.isRemote(cleanup.ref)) {
    // Nothing is left behind: the store only tells other processes the value is gone.
    await bestEffort(
      "announce a dropped inline secret",
      deps.secrets.delete(cleanup.ref, cleanup.recordId),
    );
    return;
  }
  let outcome: "held" | "done";
  try {
    outcome = await deleteUnreferencedSecret(deps, cleanup);
  } catch (error) {
    getLogger().error("secret cleanup failed; retrying", error, { "secret.kind": cleanup.kind });
    // A backup already recorded still runs at its own time when this cannot reach the queue.
    await bestEffort("retry secret cleanup now", deps.jobs.enqueue(secretCleanupJob(cleanup)));
    return;
  }
  // The backup under this key may be another transaction's, recorded as it dropped the same
  // reference. It reads the records again when it runs, so it stays.
  if (outcome === "held" && SHARED_REFERENCE_KINDS.has(cleanup.kind)) return;
  await bestEffort(
    "delete the finished secret cleanup's backup job",
    deps.jobs.cancel(secretCleanupJobKey(cleanup.ref)),
  );
}

/** For a secret no committed record refers to: records the backup, then deletes the entry. */
export async function cleanUpUnsavedSecret(
  deps: SecretCleanupDeps,
  cleanup: SecretCleanup,
): Promise<void> {
  if (deps.secrets.isRemote(cleanup.ref)) {
    try {
      await deps.jobs.enqueue(backupJob(cleanup));
    } catch (error) {
      getLogger().error("secret cleanup could not record its backup", error, {
        "secret.kind": cleanup.kind,
      });
    }
  }
  await finishSecretCleanup(deps, cleanup);
}

/** One attempt with nothing behind it: where there is no queue, the caller reports a failure. */
export async function attemptSecretCleanup(
  deps: Pick<SecretCleanupDeps, "prisma" | "secrets">,
  cleanup: SecretCleanup,
): Promise<void> {
  await deleteUnreferencedSecret(deps, cleanup);
}

/** The job's attempt: a failure is logged with its kind and left to the queue's retries. */
export async function retrySecretCleanup(
  deps: Pick<SecretCleanupDeps, "prisma" | "secrets">,
  cleanup: SecretCleanup,
): Promise<void> {
  try {
    await deleteUnreferencedSecret(deps, cleanup);
  } catch (error) {
    getLogger().error("secret cleanup retry failed", error, { "secret.kind": cleanup.kind });
    throw error;
  }
}

/**
 * The transaction a remote write runs inside, if any. Its backup is recorded on that
 * transaction's own connection, since waiting for a second one while it holds the first can stall
 * the pool. A rollback takes the backup with it, so `rolledBack` records it again afterwards.
 */
export const secretWriteTransaction = new AsyncLocalStorage<{
  client?: JobTransaction;
  rolledBack: Array<() => Promise<void>>;
}>();

/**
 * Every remote write first records the job that deletes its entry unless a row holds it by then,
 * so a process that dies between the write and the save leaves nothing behind. The save's own
 * transaction removes the job (`savedSecretIn`, or the secret tables' `saved`). Without a queue,
 * writes go ahead unrecorded; a failure to record one refuses the write.
 */
export function withSecretWriteAhead<T extends SecretStore>(
  store: T,
  jobs: () => Pick<JobPublisher, "enqueue" | "enqueueIn"> | undefined,
): T {
  const put = (plaintext: string, context: AdapterContext, options: SecretPutOptions = {}) => {
    const queue = jobs();
    if (!queue) return store.put(plaintext, context, options);
    return store.put(
      plaintext,
      { ...context, signal: deadlineSignal(STORE_WRITE_MS, context.signal) },
      {
        ...options,
        beforeWrite: async (entry) => {
          await options.beforeWrite?.(entry);
          const job = secretCleanupJob(
            { kind: "store_write", ...entry },
            new Date(Date.now() + STORE_WRITE_MS + SAVE_MARGIN_MS),
          );
          const open = secretWriteTransaction.getStore();
          if (!open?.client) return queue.enqueue(job);
          await queue.enqueueIn(open.client, job);
          open.rolledBack.push(() => queue.enqueue(job));
        },
      },
    );
  };
  return new Proxy(store, {
    get(target, property) {
      if (property === "put") return put;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * In the transaction that saves the row holding a new entry: its write-ahead job goes with that
 * commit. Every cleanup job for a reference shares one key, so a cancel after the commit could
 * delete a backup a concurrent replace recorded as it dropped the same reference.
 */
export async function savedSecretIn(
  deps: { secrets: Pick<SecretStore, "isRemote">; jobs?: Pick<JobPublisher, "cancelIn"> },
  tx: JobTransaction,
  ref: string,
): Promise<void> {
  if (deps.jobs && deps.secrets.isRemote(ref))
    await deps.jobs.cancelIn(tx, secretCleanupJobKey(ref));
}
