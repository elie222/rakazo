import type {
  AdapterContext,
  BackgroundJobPayloads,
  JobPublisher,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { connectionCleanupJob, RetryJobLaterError } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { ProviderTransactionBusyError, runProviderTransaction } from "@rakazo/db";
import { getLogger, unwrapJobPayload } from "@rakazo/logging";
import { advisoryLock } from "./advisory-lock.js";
import { sanitizeIntegrationError } from "./composio-connector.js";
import type { ConnectorRegistry } from "./connector-registry.js";
import { prepareManagedConnectorForTransaction } from "./integration-provider-settings.js";

type ConnectionScope = { spaceId: string; userId: string; connectorId: string; provider: string };
type ConnectionCleanup = BackgroundJobPayloads["connection.cleanup"];

/** Connection flows hold the provider lock across provider calls (45s budget plus database work). */
export const PROVIDER_LOCK_TRANSACTION_MS = 60_000;

/**
 * One attempt's provider budget, short of the lock transaction's timeout. It starts when the
 * provider call does, never while the attempt is still waiting for its scope.
 */
export const CONNECTION_CLEANUP_ATTEMPT_MS = 45_000;

/** How long a cleanup waits for its scope's slot before leaving the scope to the flow that has it. */
const CONNECTION_CLEANUP_SLOT_WAIT_MS = 2_000;

/** When the backup job runs if the direct attempt never reports back: its slot wait, its call, a margin. */
export const CONNECTION_CLEANUP_BACKUP_MS =
  CONNECTION_CLEANUP_SLOT_WAIT_MS + CONNECTION_CLEANUP_ATTEMPT_MS + 15_000;

/** When a cleanup that found another flow holding its scope runs again. */
const CONNECTION_CLEANUP_BUSY_RETRY_MS = 15_000;

/** The soonest a cleanup looks again at accounts a sibling's unfinished connection may still own. */
const CONNECTION_CLEANUP_UNDECIDED_RETRY_MS = 60_000;

/**
 * How one attempt ended. Only `done` (removed, or nothing left to remove) lets the backup job
 * go: `busy` means another flow holds the scope, `undecided` that a sibling's unfinished
 * connection may still own the accounts.
 */
export type ConnectionCleanupOutcome = "done" | "busy" | "undecided";

/** When the backup job of an attempt that could not finish runs again. */
export function connectionCleanupRetryAt(outcome: "busy" | "undecided"): Date {
  return new Date(
    Date.now() +
      (outcome === "busy"
        ? CONNECTION_CLEANUP_BUSY_RETRY_MS
        : CONNECTION_CLEANUP_UNDECIDED_RETRY_MS),
  );
}

const ACTIVE_STATUSES = ["connected", "pending", "error"];

/**
 * The scope one connection flow serializes on: one user's rows for one provider. The
 * advisory locks and the provider transaction gate share it, so the gate queues only
 * behind work the database would serialize anyway.
 */
export function providerScopeKey(
  owner: { spaceId: string; userId: string },
  connectorId: string,
  provider: string,
): string {
  // Avoid NUL separators in the lock key; text params may truncate at a zero byte and break begin.
  return `space:${owner.spaceId}|user:${owner.userId}|connector:${connectorId}|provider:${provider}`;
}

export async function lockProviderConnectionScope(
  tx: Prisma.TransactionClient,
  owner: { spaceId: string; userId: string },
  connectorId: string,
  provider: string,
): Promise<void> {
  await advisoryLock(tx, "connection-provider", providerScopeKey(owner, connectorId, provider));
}

/** Like lockProviderConnectionScope, but returns false instead of waiting for a holder. */
export async function tryLockProviderConnectionScope(
  tx: Prisma.TransactionClient,
  owner: { spaceId: string; userId: string },
  connectorId: string,
  provider: string,
): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtext('connection-provider'), hashtext(${providerScopeKey(owner, connectorId, provider)})) AS locked`;
  return row?.locked === true;
}

/**
 * A provider-lock transaction, run through the provider transaction gate keyed to its
 * scope, so a slow provider pins at most one pooled connection per scope and a bounded
 * share of the pool overall, however many requests are waiting.
 */
export function providerLockTransaction<T>(
  prisma: PrismaClient,
  scope: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  waitMs = PROVIDER_LOCK_TRANSACTION_MS,
): Promise<T> {
  return runProviderTransaction(
    scope,
    () => prisma.$transaction(fn, { timeout: PROVIDER_LOCK_TRANSACTION_MS }),
    waitMs,
  );
}

/**
 * Concrete account ids still referenced by active local rows. When any row still
 * only has the provider slug (or no ref), orphan cleanup must not run — a sibling
 * may have created its remote account before persisting the concrete id.
 */
function concreteKeepAccountIds(
  refs: Array<string | null | undefined>,
  provider: string,
): { keepIds: string[]; canRevokeUnreferenced: boolean } {
  const keepIds: string[] = [];
  let canRevokeUnreferenced = true;
  for (const ref of refs) {
    const value = ref?.trim();
    if (!value || value === provider) {
      canRevokeUnreferenced = false;
      continue;
    }
    keepIds.push(value);
  }
  return { keepIds, canRevokeUnreferenced };
}

/** What a begin whose result is not saved leaves at the provider, when the connector can remove it. */
export function leftoverAuthorization(
  connector: ManagedConnectorProvider,
  scope: ConnectionScope,
  state: string | undefined,
): ConnectionCleanup | undefined {
  const ref = state?.trim();
  if (!ref) return undefined;
  const { spaceId, userId, connectorId, provider } = scope;
  // A request or account id is removed by id; an app slug names no single account.
  if (ref !== provider) return { spaceId, userId, connectorId, provider, ref };
  return connector.revokeUnreferencedAccounts
    ? { spaceId, userId, connectorId, provider }
    : undefined;
}

/**
 * Cancel an authorization request, or revoke the account it became. The provider holding
 * nothing for the ref is success; failing to ask it rejects, so the caller retries.
 */
export async function dropAuthorization(
  connector: ManagedConnectorProvider,
  target: { spaceId: string; userId: string; provider: string; ref: string },
  context: AdapterContext,
): Promise<void> {
  // Cancelling by id keeps the authorization URL from creating an untracked account later;
  // an account id is resolved only when the connector cannot cancel.
  if (connector.cancelAuthorizationRequest) {
    await connector.cancelAuthorizationRequest(target.ref, context);
    return;
  }
  const accountId = connector.resolveConnectedAccountId
    ? await connector.resolveConnectedAccountId(
        target.userId,
        target.provider,
        target.ref,
        [],
        target.spaceId,
      )
    : target.ref;
  if (accountId) await connector.revoke(accountId, context);
}

/**
 * Delete the provider's accounts for one app that no active local row references. The caller
 * holds the provider lock, so a concurrent complete cannot save an account id this deletes.
 * `undecided` while a sibling has not saved its account id yet: any of them may be its own.
 */
export async function dropUnreferencedAccounts(
  tx: Pick<Prisma.TransactionClient, "connection">,
  connector: ManagedConnectorProvider,
  scope: ConnectionScope,
  context: AdapterContext,
): Promise<"done" | "undecided"> {
  if (!connector.revokeUnreferencedAccounts) return "done";
  const kept = await tx.connection.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      connectorId: scope.connectorId,
      provider: scope.provider,
      status: { in: ACTIVE_STATUSES },
    },
    select: { providerRef: true },
  });
  const { keepIds, canRevokeUnreferenced } = concreteKeepAccountIds(
    kept.map((entry) => entry.providerRef),
    scope.provider,
  );
  if (!canRevokeUnreferenced) return "undecided";
  await connector.revokeUnreferencedAccounts(scope.provider, keepIds, context);
  return "done";
}

function cleanupContext(
  owner: { spaceId: string; userId: string },
  operationId: string,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: owner.spaceId,
    userId: owner.userId,
    signal: AbortSignal.timeout(CONNECTION_CLEANUP_ATTEMPT_MS),
  };
}

/**
 * Runs `fn` holding the scope's provider lock, or answers `busy` without waiting when another
 * flow has it: that flow may be mid provider call, and waiting it out would pin a pooled
 * connection and leave no time for this attempt's own call.
 */
async function whileScopeIsFree<T>(
  prisma: PrismaClient,
  scope: ConnectionScope,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T | "busy"> {
  try {
    return await providerLockTransaction(
      prisma,
      providerScopeKey(scope, scope.connectorId, scope.provider),
      async (tx) =>
        (await tryLockProviderConnectionScope(tx, scope, scope.connectorId, scope.provider))
          ? fn(tx)
          : "busy",
      CONNECTION_CLEANUP_SLOT_WAIT_MS,
    );
  } catch (error) {
    if (error instanceof ProviderTransactionBusyError) return "busy";
    throw error;
  }
}

/**
 * The direct attempt at removing what a begin whose result was not saved left behind. Rejects
 * when the provider or the database could not be asked.
 */
export async function dropLeftoverAuthorization(
  prisma: PrismaClient,
  connector: ManagedConnectorProvider,
  leftover: ConnectionCleanup,
  operationId: string,
): Promise<ConnectionCleanupOutcome> {
  const { ref } = leftover;
  if (ref) {
    await dropAuthorization(connector, { ...leftover, ref }, cleanupContext(leftover, operationId));
    return "done";
  }
  return whileScopeIsFree(prisma, leftover, (tx) =>
    dropUnreferencedAccounts(tx, connector, leftover, cleanupContext(leftover, operationId)),
  );
}

function cleanupReferences(cleanup: ConnectionCleanup) {
  return {
    spaceId: cleanup.spaceId,
    userId: cleanup.userId,
    connectorId: cleanup.connectorId,
    provider: cleanup.provider,
    ...(cleanup.ref ? { providerRef: cleanup.ref } : {}),
  };
}

/**
 * The backup job. It finishes only when the removal happened or nothing is left to remove;
 * every other ending rejects, so the queue retries it, or reschedules it under its own key.
 */
export async function retryConnectionCleanup(
  deps: {
    prisma: PrismaClient;
    connectors: Pick<ConnectorRegistry, "managed">;
    jobs: Pick<JobPublisher, "enqueue">;
  },
  payload: ConnectionCleanup,
): Promise<void> {
  const configured = deps.connectors.managed(payload.connectorId);
  if (!configured) {
    // The registry lists every managed connector of this release, with or without credentials,
    // so an id it does not list is a connector this deployment no longer has: no retry can reach
    // its provider.
    getLogger().error(
      "connection cleanup abandoned: this deployment has no such connector; remove the authorization at the provider by hand",
      cleanupReferences(payload),
    );
    return;
  }
  const prepared = await prepareManagedConnectorForTransaction(configured);
  const connector = prepared.provider;
  // Credentials that are missing now may be saved again, so this attempt fails and is retried.
  if (!connector) throw new Error("connection cleanup has no credentials for its connector");
  const outcome = await whileScopeIsFree(deps.prisma, payload, async (tx) => {
    if (prepared.recheck && !(await prepared.recheck(tx)))
      throw new Error("Integration credentials changed during connection cleanup");
    const context = cleanupContext(payload, "connection.cleanup");
    const { ref } = payload;
    if (!ref) return dropUnreferencedAccounts(tx, connector, payload, context);
    // A flow that ran since the failure may have saved this account on a row, which owns it now.
    const adopted = await tx.connection.findFirst({
      where: {
        spaceId: payload.spaceId,
        userId: payload.userId,
        connectorId: payload.connectorId,
        provider: payload.provider,
        providerRef: ref,
        status: { in: ACTIVE_STATUSES },
      },
      select: { id: true },
    });
    if (!adopted) await dropAuthorization(connector, { ...payload, ref }, context);
    return "done" as const;
  });
  if (outcome === "busy") {
    // Not a failed attempt: replacing the job under its key starts it afresh, so a scope that
    // other flows keep busy never uses up its retries.
    await deps.jobs.enqueue(connectionCleanupJob(payload, connectionCleanupRetryAt("busy")));
    return;
  }
  if (outcome === "undecided") throw new RetryJobLaterError(CONNECTION_CLEANUP_UNDECIDED_RETRY_MS);
}

function isConnectionCleanup(payload: unknown): payload is ConnectionCleanup {
  return (
    payload !== null &&
    typeof payload === "object" &&
    "connectorId" in payload &&
    "provider" in payload &&
    "spaceId" in payload &&
    "userId" in payload
  );
}

/** The queue emits this once a `connection.cleanup` job has used its last attempt. */
export function recordConnectionCleanupAttemptsExhausted(
  job: { task_identifier: string; payload: unknown; attempts: number },
  error: unknown,
): void {
  if (job.task_identifier !== "connection.cleanup") return;
  const { payload } = unwrapJobPayload(job.payload);
  getLogger().error(
    "connection cleanup gave up; remove the authorization at the provider by hand",
    {
      ...(isConnectionCleanup(payload) ? cleanupReferences(payload) : {}),
      "job.attempts": job.attempts,
      reason: sanitizeIntegrationError(error),
    },
  );
}
