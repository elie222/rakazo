import type {
  AdapterContext,
  BackgroundJobPayloads,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { runProviderTransaction } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { advisoryLock } from "./advisory-lock.js";
import type { ConnectorRegistry } from "./connector-registry.js";
import { prepareManagedConnectorForTransaction } from "./integration-provider-settings.js";

type ConnectionScope = { spaceId: string; userId: string; connectorId: string; provider: string };
type ConnectionCleanup = BackgroundJobPayloads["connection.cleanup"];

/** Connection flows hold the provider lock across provider calls (45s budget plus database work). */
export const PROVIDER_LOCK_TRANSACTION_MS = 60_000;

/** One attempt's provider budget, short of the lock transaction's timeout. */
export const CONNECTION_CLEANUP_ATTEMPT_MS = 45_000;

/** When the backup job runs if the direct attempt never reports back: its lock wait, its call, a margin. */
export const CONNECTION_CLEANUP_BACKUP_MS =
  PROVIDER_LOCK_TRANSACTION_MS + CONNECTION_CLEANUP_ATTEMPT_MS + 15_000;

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
 */
export async function dropUnreferencedAccounts(
  tx: Pick<Prisma.TransactionClient, "connection">,
  connector: ManagedConnectorProvider,
  scope: ConnectionScope,
  context: AdapterContext,
): Promise<void> {
  if (!connector.revokeUnreferencedAccounts) return;
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
  // A sibling without a concrete account id may own any of them.
  if (!canRevokeUnreferenced) return;
  await connector.revokeUnreferencedAccounts(scope.provider, keepIds, context);
}

/** One attempt at removing what a lost begin left behind. Rejects when it could not finish. */
export async function dropLeftoverAuthorization(
  prisma: PrismaClient,
  connector: ManagedConnectorProvider,
  leftover: ConnectionCleanup,
  context: AdapterContext,
): Promise<void> {
  const { ref } = leftover;
  if (ref) return dropAuthorization(connector, { ...leftover, ref }, context);
  await providerLockTransaction(
    prisma,
    providerScopeKey(leftover, leftover.connectorId, leftover.provider),
    async (tx) => {
      await lockProviderConnectionScope(tx, leftover, leftover.connectorId, leftover.provider);
      await dropUnreferencedAccounts(tx, connector, leftover, context);
    },
  );
}

/** The backup job: the queue retries a rejection, so nothing here catches one. */
export async function retryConnectionCleanup(
  deps: { prisma: PrismaClient; connectors: Pick<ConnectorRegistry, "managed"> },
  payload: ConnectionCleanup,
): Promise<void> {
  const configured = deps.connectors.managed(payload.connectorId);
  const prepared = configured ? await prepareManagedConnectorForTransaction(configured) : undefined;
  const connector = prepared?.provider;
  if (!connector) {
    // Without the connector's credentials nothing can reach the provider, now or on a retry.
    getLogger().error("connection cleanup dropped: its connector is no longer configured", {
      connectorId: payload.connectorId,
      provider: payload.provider,
      ...(payload.ref ? { providerRef: payload.ref } : {}),
    });
    return;
  }
  const context: AdapterContext = {
    operationId: "connection.cleanup",
    traceId: "connection.cleanup",
    spaceId: payload.spaceId,
    userId: payload.userId,
    signal: AbortSignal.timeout(CONNECTION_CLEANUP_ATTEMPT_MS),
  };
  await providerLockTransaction(
    deps.prisma,
    providerScopeKey(payload, payload.connectorId, payload.provider),
    async (tx) => {
      await lockProviderConnectionScope(tx, payload, payload.connectorId, payload.provider);
      if (prepared.recheck && !(await prepared.recheck(tx)))
        throw new Error("Integration credentials changed during connection cleanup");
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
    },
  );
}
