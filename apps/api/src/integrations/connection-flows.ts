import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  BackgroundJobPayloads,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { ConnectorAuthUnavailableError, connectionCleanupJob } from "@rakazo/adapter-kit";
import type { ConnectionOwner } from "@rakazo/adapters";
import {
  advisoryLock,
  authorizationInUse,
  CONNECTION_CLEANUP_BACKUP_MS,
  connectionCleanupRetryAt,
  connectionOwnerWhere,
  connectionProviderWhere,
  dropLeftoverAuthorization,
  hostedSignInCleanupJob,
  leftoverAuthorization,
  lockProviderConnectionScope,
  PROVIDER_LOCK_TRANSACTION_MS,
  pickReusableConnection,
  prepareManagedConnectorForTransaction,
  providerLockTransaction,
  providerScopeKey,
  readHostedSignIn,
  settleRevokedHostedSignIn,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ClientError, connectionLabelFrom, matchFeaturedConnectorId } from "@rakazo/core";
import { normalizedHttpUrl } from "@rakazo/core/egress";
import type { Prisma } from "@rakazo/db";
import {
  IsolationError,
  lockOrganizationSpaces,
  ProviderTransactionBusyError,
  recordSecurityEvent,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { connectionCreatedEvent } from "../auth/security-audit.js";
import type { RouterDeps } from "../router.js";
import {
  findManagedConnection,
  publishConnectionChange,
  requireConnectionOrganization,
  throwConnectionNameConflict,
} from "./connection-ownership.js";
import { recordToolConnected } from "./tool-connect-analytics.js";

function isAmbiguousRemoteRevokeFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted|network|ECONNRESET|ECONNREFUSED|fetch failed/i.test(message);
}

/** True when a connector failed before issuing any remote DELETE. */
function isRemoteRevokePreDeleteFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "remoteRevokePreDelete" in error &&
      (error as { remoteRevokePreDelete?: boolean }).remoteRevokePreDelete === true,
  );
}

function shouldRestoreLocalAfterRemoteRevokeFailure(error: unknown): boolean {
  // Pre-delete list/network failures never reached DELETE — always keep retry state.
  // Post-delete timeouts stay ambiguous and leave the row revoked.
  return isRemoteRevokePreDeleteFailure(error) || !isAmbiguousRemoteRevokeFailure(error);
}

export function requireNoPendingSignIn(pending: boolean) {
  if (pending)
    throw new ClientError("CONFLICT", "Finish or remove the pending sign-in for this app first.");
}

/** Retire an expired hosted attempt while preserving its baseline for cleanup. */
export async function expireHostedSignIn(
  tx: Prisma.TransactionClient,
  jobs: RouterDeps["jobs"],
  owner: ConnectionOwner & { organizationId: string },
  row: Parameters<typeof readHostedSignIn>[0] & { status: string },
  listAccounts: () => Promise<string[]>,
) {
  if (row.status !== "pending" || row.providerRef !== row.provider) return;
  const { expiresAt, priorAccountIds } = readHostedSignIn(row);
  const expiry = Date.parse(expiresAt ?? "");
  if (!Number.isFinite(expiry) || expiry > Date.now()) return;

  // Expiration closes the link. A completed authorization can still be claimed.
  if (!priorAccountIds || (await listAccounts()).some((id) => !priorAccountIds.includes(id)))
    return;

  const revoked = await tx.connection.update({
    where: { id: row.id },
    data: { status: "revoked" },
  });
  await jobs.enqueueIn(
    tx,
    hostedSignInCleanupJob(
      {
        ...owner,
        connectorId: row.connectorId,
        provider: row.provider,
        connectionId: row.id,
      },
      new Date(expiry),
    ),
  );
  return revoked;
}

export function connectionContext(
  actor: ConnectionOwner,
  operationId: string,
  signal?: AbortSignal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    ...(actor.organizationId ? { organizationId: actor.organizationId } : {}),
    signal: signal ?? new AbortController().signal,
  };
}

export function connectionFlowOwner(
  { spaceId, userId }: Actor,
  organizationId?: string,
): ConnectionOwner {
  return { spaceId, userId, ...(organizationId ? { organizationId } : {}) };
}

/**
 * Removes what a begin whose result was not saved left at the provider. The keyed backup job is
 * the durable record: an attempt that failed, found the scope busy or could not decide yet hands
 * over to it, and only a finished removal deletes it. The attempt itself takes the scope's
 * provider lock and leaves alone what an active row has saved, as the job does, so it needs no
 * answer to whether the begin's save landed: a row that holds the result keeps the authorization.
 * Never rejects, so the caller's own error is the one reported.
 */
async function removeLeftoverAuthorization(
  deps: Pick<RouterDeps, "prisma" | "jobs">,
  connector: ManagedConnectorProvider,
  leftover: BackgroundJobPayloads["connection.cleanup"] & { organizationId?: string },
  backedUp: boolean,
): Promise<void> {
  const where = {
    connectorId: leftover.connectorId,
    provider: leftover.provider,
    ...(leftover.ref ? { providerRef: leftover.ref } : {}),
  };
  let recorded = backedUp;
  /** Records the backup job, or moves the recorded one; an earlier record survives a failure. */
  const record = async (availableAt?: Date) => {
    try {
      await deps.jobs.enqueue(connectionCleanupJob(leftover, availableAt));
      recorded = true;
    } catch (error) {
      getLogger().warn("connections.begin could not record its leftover cleanup", {
        error,
        ...where,
      });
    }
  };
  /** Leaves an unfinished removal to the job, and says so when nothing is left to retry it. */
  const handOver = async (availableAt?: Date) => {
    await record(availableAt);
    if (recorded) return;
    getLogger().error(
      "connections.begin leftover cleanup has no backup job; remove the authorization at the provider by hand",
      { spaceId: leftover.spaceId, userId: leftover.userId, ...where },
    );
  };
  if (!recorded) await record(cleanupBackupAt());
  try {
    // Its own time budget, not the request signal: a caller that hangs up must not cut it short.
    const drop = () => dropLeftoverAuthorization(deps, connector, leftover, "connections.begin");
    const outcome = leftover.organizationId
      ? await runAsSystem(
          "check the organization still owns the authorization before removing it",
          drop,
        )
      : await drop();
    if (outcome !== "done") await handOver(connectionCleanupRetryAt(outcome));
  } catch (error) {
    getLogger().warn("connections.begin leftover cleanup failed; retrying", { error, ...where });
    await handOver();
  }
}

function cleanupBackupAt(): Date {
  return new Date(Date.now() + CONNECTION_CLEANUP_BACKUP_MS);
}

type ReconnectingConnection = {
  id: string;
  provider: string;
  status: string;
  providerRef: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function beginConnection(
  deps: RouterDeps,
  context: { actor: Actor; signal?: AbortSignal },
  request: { connectorId?: string; provider: string; displayName: string },
  organizationId?: string,
  reconnecting?: ReconnectingConnection,
) {
  const owner = connectionFlowOwner(context.actor, organizationId);
  const owned = connectionOwnerWhere(owner);
  const input = {
    ...request,
    connectorId: request.connectorId ?? deps.connectors.defaultConnectorId,
  };
  const connector = deps.integrationSettings?.has(input.connectorId)
    ? await deps.integrationSettings.resolve(input.connectorId)
    : deps.connectors.managed(input.connectorId);
  if (!connector)
    throw new ClientError("BAD_REQUEST", `Connector ${input.connectorId} is not configured`);
  // The row belongs to this attempt until a revoke takes it or a later begin reuses it.
  const attempt = randomUUID();
  const startedAt = Date.now();
  let connectionId: string | undefined;
  function logSetup(
    outcome:
      | "authorization_ready"
      | "connected"
      | "request_aborted"
      | "auth_config_unavailable"
      | "provider_failed"
      | "invalid_authorization_url"
      | "initial_save_failed"
      | "save_failed"
      | "superseded",
  ) {
    getLogger().info("tool connection setup", {
      "connection.id": connectionId,
      "connection.attempt_id": attempt,
      "connection.app": matchFeaturedConnectorId(input.provider) ?? undefined,
      "connection.setup_outcome": outcome,
      "connection.elapsed_ms": Date.now() - startedAt,
    });
  }
  // Share the revoke scope lock so a slug-wide remote delete cannot miss a
  // row that is inserted after SELECT FOR UPDATE and before remote revoke.
  // Complete and revoke hold that lock across provider calls, so wait as long as they may.
  const reserve = () =>
    providerLockTransaction(
      deps.prisma,
      providerScopeKey(owner, input.connectorId, input.provider),
      async (tx) => {
        await lockProviderConnectionScope(tx, owner, input.connectorId, input.provider);
        if (organizationId) await requireConnectionOrganization(tx, context.actor, organizationId);
        const existing = await tx.connection.findMany({
          where: {
            ...owned,
            connectorId: input.connectorId,
            provider: connectionProviderWhere(owner, input.provider),
          },
          select: {
            id: true,
            status: true,
            connectorId: true,
            provider: true,
            providerRef: true,
            metadata: true,
            updatedAt: true,
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        });
        const listAccounts = connector.listAccountsBeforeSignIn?.bind(connector);
        if (organizationId && listAccounts) {
          for (const previous of existing) {
            if (previous.status !== "pending") continue;
            requireNoPendingSignIn(
              !(await expireHostedSignIn(
                tx,
                deps.jobs,
                { ...owner, organizationId },
                previous,
                () =>
                  listAccounts(
                    input.provider,
                    connectionContext(owner, "connections.begin", context.signal),
                  ),
              )),
            );
          }
        }
        let displayName = input.displayName;
        if (organizationId) {
          // Deletion takes this lock before placing its claim and discovering providers.
          await lockOrganizationSpaces(tx, organizationId);
          await requireConnectionOrganization(tx, context.actor, organizationId);
          await advisoryLock(tx, "organization-connection-label", organizationId);
          const names = new Set(
            (
              await tx.connection.findMany({
                where: { organizationId, status: { not: "revoked" } },
                select: { displayName: true },
              })
            ).map((row) => row.displayName.toLowerCase()),
          );
          for (let number = 2; names.has(displayName.toLowerCase()); number += 1) {
            displayName = connectionLabelFrom(input.displayName, input.provider, ` ${number}`);
          }
        }
        // A revoked hosted link may still be live. Keep its row and expiration
        // until the new attempt has checked it.
        const reusable =
          organizationId && connector.listAccountsBeforeSignIn
            ? undefined
            : pickReusableConnection(existing);
        if (reusable) {
          return tx.connection.update({
            where: { id: reusable.id },
            data: {
              displayName,
              status: "pending",
              providerRef: null,
              metadata: { attempt },
            },
          });
        }
        return tx.connection.create({
          data: {
            ...owned,
            connectorId: input.connectorId,
            provider: input.provider,
            displayName,
            status: "pending",
            metadata: { attempt },
          },
        });
      },
    ).catch((error: unknown) => {
      logSetup("initial_save_failed");
      if (organizationId) throwConnectionNameConflict(error);
      throw error;
    });
  const row = reconnecting ?? (await reserve());
  connectionId = row.id;
  // Exactly what the first transaction wrote: this attempt's row, with no result saved on it.
  const unsavedRow = {
    id: row.id,
    ...owned,
    status: "pending",
    metadata: { equals: { attempt } },
  };
  /**
   * Marks the row failed while it holds nothing. A row whose save landed, even one that reported
   * a failure, stays what the save made it: it is the record of the authorization, and a later
   * begin that reused it as a failed row would drop that record.
   */
  const markFailed = async () => {
    if (reconnecting) return;
    try {
      await deps.prisma.connection.updateMany({ where: unsavedRow, data: { status: "error" } });
    } catch (error) {
      getLogger().warn("connections.begin could not mark its connection failed", {
        error,
        connectionId: row.id,
      });
    }
  };
  let auth: Awaited<ReturnType<ManagedConnectorProvider["begin"]>>;
  try {
    auth = await connector.begin(
      {
        provider: input.provider,
        redirectUrl: `${deps.env.webOrigin}/integrations/callback`,
      },
      connectionContext(owner, "connections.begin", context.signal),
    );
  } catch (error) {
    logSetup(
      error instanceof ConnectorAuthUnavailableError
        ? "auth_config_unavailable"
        : context.signal?.aborted && error === context.signal.reason
          ? "request_aborted"
          : "provider_failed",
    );
    await markFailed();
    if (error instanceof ConnectorAuthUnavailableError) {
      getLogger().warn("connections.begin app has no usable auth config", {
        connectorId: input.connectorId,
        provider: input.provider,
        reason: String(error.cause),
      });
    }
    throw error;
  }
  const scope = { ...owner, connectorId: input.connectorId, provider: input.provider };
  const hosted = Boolean(organizationId && connector.listAccountsBeforeSignIn);
  const leftover = hosted ? undefined : leftoverAuthorization(connector, scope, auth.state);
  const replacedRef = reconnecting?.providerRef;
  const replaced =
    replacedRef && replacedRef !== auth.state && (!hosted || replacedRef !== input.provider)
      ? leftoverAuthorization(
          connector,
          scope,
          !hosted && auth.state === input.provider ? auth.state : replacedRef,
        )
      : undefined;
  // Never send an opaque provider reference or a non-web URI to native URL handlers.
  if (auth.authorizationUrl) {
    const authorizationUrl = normalizedHttpUrl(auth.authorizationUrl);
    if (!authorizationUrl) {
      logSetup("invalid_authorization_url");
      await markFailed();
      if (leftover) await removeLeftoverAuthorization(deps, connector, leftover, false);
      throw new ClientError("SERVICE_UNAVAILABLE", "The app returned an invalid sign-in URL.");
    }
    auth = { ...auth, authorizationUrl };
  }
  // Re-take the provider lock and only advance the row while it is still this attempt's, so
  // a concurrent revoke cannot be overwritten back to pending/connected, and neither can the
  // result of a later begin that reused the row.
  const pending = Boolean(auth.authorizationUrl || auth.requiresCompletion);
  let applied: boolean;
  try {
    applied = await providerLockTransaction(
      deps.prisma,
      providerScopeKey(owner, input.connectorId, input.provider),
      async (tx) => {
        await lockProviderConnectionScope(tx, owner, input.connectorId, input.provider);
        if (organizationId) await requireConnectionOrganization(tx, context.actor, organizationId);
        let priorAccountIds: string[] | undefined;
        if (organizationId && pending && connector.listAccountsBeforeSignIn) {
          requireNoPendingSignIn(
            (await tx.connection.count({
              where: {
                ...owned,
                connectorId: input.connectorId,
                provider: connectionProviderWhere(owner, input.provider),
                status: "pending",
                id: { not: row.id },
              },
            })) > 0,
          );
          if (!auth.expiresAt || !Number.isFinite(Date.parse(auth.expiresAt)))
            throw new ClientError("SERVICE_UNAVAILABLE", "The sign-in link has no expiration.");
          const revoked = await tx.connection.findMany({
            where: {
              ...owned,
              connectorId: input.connectorId,
              provider: connectionProviderWhere(owner, input.provider),
              providerRef: { equals: input.provider, mode: "insensitive" },
              status: "revoked",
            },
          });
          const hostedContext = connectionContext(owner, "connections.begin", context.signal);
          for (const previous of revoked)
            await settleRevokedHostedSignIn(tx, connector, previous, hostedContext);
          priorAccountIds = await connector.listAccountsBeforeSignIn(
            input.provider,
            connectionContext(owner, "connections.begin", context.signal),
          );
        }
        if (organizationId) {
          // A claim taken while the remote request was running must win over publication.
          await lockOrganizationSpaces(tx, organizationId);
          await requireConnectionOrganization(tx, context.actor, organizationId);
        }
        const updated = await tx.connection.updateMany({
          where: reconnecting
            ? {
                id: reconnecting.id,
                ...owned,
                status: reconnecting.status,
                updatedAt: reconnecting.updatedAt,
              }
            : unsavedRow,
          data: {
            status: pending ? "pending" : "connected",
            providerRef: auth.state || null,
            metadata: {
              state: auth.state,
              attempt,
              ...(priorAccountIds && { priorAccountIds, expiresAt: auth.expiresAt }),
            },
          },
        });
        if (updated.count > 0) {
          if (replaced)
            await deps.jobs.enqueueIn(tx, connectionCleanupJob(replaced, cleanupBackupAt()));
          return true;
        }
        // Lost the row: removing what begin left at the provider commits with that outcome.
        if (leftover)
          await deps.jobs.enqueueIn(tx, connectionCleanupJob(leftover, cleanupBackupAt()));
        return false;
      },
    );
  } catch (error) {
    // The slot stayed busy, or the transaction or its job write failed, after the provider had
    // already answered. The row is marked failed first, or the removal would wait for it as for
    // a connection still in flight.
    logSetup("save_failed");
    await markFailed();
    if (leftover) await removeLeftoverAuthorization(deps, connector, leftover, false);
    throw error;
  }
  if (!applied) {
    logSetup("superseded");
    if (leftover) await removeLeftoverAuthorization(deps, connector, leftover, true);
    if (reconnecting) throw new ClientError("CONFLICT", "This connection changed. Try again.");
    throw new IsolationError();
  }
  if (replaced) await removeLeftoverAuthorization(deps, connector, replaced, true);
  logSetup(pending ? "authorization_ready" : "connected");
  if (!pending) {
    await recordSecurityEvent(connectionCreatedEvent("connections.begin", row.id, context.actor));
    recordToolConnected(deps.analytics, context.actor.userId, row);
  }
  await publishConnectionChange(deps, context.actor, organizationId);
  return { connectionId: row.id, authorizationUrl: auth.authorizationUrl };
}

/** A removal's provider call ends this long into its transaction, leaving time to commit. */
const REVOKE_CALL_ENDS_BY_MS = PROVIDER_LOCK_TRANSACTION_MS - 15_000;
/** Less than this left and the provider call would likely be cut off part-way. */
const MIN_REVOKE_CALL_MS = 10_000;

export async function revokeConnection(
  deps: RouterDeps,
  context: { actor: Actor; signal?: AbortSignal },
  input: { connectionId: string },
) {
  const snapshot = await findManagedConnection(deps.prisma, context.actor, input.connectionId);
  const organizationId = snapshot?.organizationId ?? undefined;
  const owner = connectionFlowOwner(context.actor, organizationId);
  const owned = connectionOwnerWhere(owner);
  // Prepared before the transaction, so the provider call inside it reads nothing from the pool.
  const active = snapshot && ["connected", "pending", "error"].includes(snapshot.status);
  const configured = active ? deps.connectors.managed(snapshot.connectorId) : undefined;
  const prepared = configured ? await prepareManagedConnectorForTransaction(configured) : undefined;
  // The row is marked revoked and its authorization removed in one transaction, under the
  // provider lock: a failed removal, or a process that dies around the provider call, rolls the
  // row back to what it was, so the row stays the record of an authorization that may remain.
  const outcome = await providerLockTransaction(
    deps.prisma,
    // The pre-transaction snapshot owns the scope; the row's connector and provider
    // never change, and without it (row already gone) the transaction is a quick read.
    snapshot
      ? providerScopeKey(owner, snapshot.connectorId, snapshot.provider)
      : `connection:${input.connectionId}`,
    async (tx): Promise<{ uncertain?: unknown }> => {
      const startedAt = Date.now();
      if (snapshot && organizationId)
        await lockProviderConnectionScope(tx, owner, snapshot.connectorId, snapshot.provider);
      const row = await tx.connection.findFirst({
        where: {
          id: input.connectionId,
          ...owned,
        },
      });
      if (!row) return {};
      if (organizationId) await requireConnectionOrganization(tx, context.actor, organizationId);

      // Advisory lock covers inserts as well as existing rows. SELECT FOR UPDATE
      // alone misses a concurrent begin that inserts after the lock query.
      if (organizationId) {
        await tx.$queryRaw`
          SELECT id FROM connections WHERE "organizationId" = ${organizationId} AND id = ${row.id}
          FOR UPDATE`;
      } else {
        await lockProviderConnectionScope(tx, owner, row.connectorId, row.provider);
        await tx.$queryRaw`
        SELECT id
        FROM connections
        WHERE "spaceId" = ${context.actor.spaceId}
          AND "userId" = ${context.actor.userId}
          AND "connectorId" = ${row.connectorId}
          AND provider = ${row.provider}
          AND status IN ('connected', 'pending', 'error')
        FOR UPDATE`;
      }

      const updated = await tx.connection.updateMany({
        where: {
          id: row.id,
          ...owned,
          status: { in: ["connected", "pending", "error"] },
        },
        data: { status: "revoked" },
      });
      if (updated.count === 0) return {};

      if (
        organizationId &&
        row.status === "pending" &&
        (!row.providerRef || row.providerRef === row.provider)
      ) {
        const { expiresAt, priorAccountIds } = readHostedSignIn(row);
        const expiry = Date.parse(expiresAt ?? "");
        if (priorAccountIds && Number.isFinite(expiry)) {
          await deps.jobs.enqueueIn(
            tx,
            hostedSignInCleanupJob(
              {
                ...owner,
                organizationId,
                connectorId: row.connectorId,
                provider: row.provider,
                connectionId: row.id,
              },
              new Date(expiry),
            ),
          );
          return {};
        }
        if (prepared?.provider?.listAccountsBeforeSignIn) return {};
      }

      const remaining = await tx.connection.count({
        where: {
          ...owned,
          connectorId: row.connectorId,
          provider: connectionProviderWhere(owner, row.provider),
          OR: [
            { status: { in: ["connected", "pending"] } },
            { status: "error", providerRef: { not: null } },
          ],
        },
      });
      const connectionRef = row.providerRef || row.provider;
      const accountSpecific = Boolean(row.providerRef && row.providerRef !== row.provider);
      // Revoking a legacy slug removes all remote accounts for the app.
      if (!accountSpecific && remaining > 0) return {};
      const scope = {
        ...owner,
        connectorId: row.connectorId,
        provider: row.provider,
      };
      // Another active row saved the same account: it keeps it, and this row only lets go.
      if (accountSpecific && (await authorizationInUse(tx, scope, connectionRef))) return {};

      // The provider call runs before commit, still holding the begin/revoke lock: a slug-only
      // delete is provider-wide and must not wipe an authorization created meanwhile, and no
      // other row can save this account while it is being removed.
      if (
        !active ||
        row.connectorId !== snapshot?.connectorId ||
        row.provider !== snapshot?.provider ||
        (prepared?.recheck && !(await prepared.recheck(tx)))
      ) {
        throw new ClientError("CONFLICT", "Integration credentials changed; retry.");
      }
      const connector = prepared?.provider;
      if (!connector) {
        throw new ClientError("BAD_REQUEST", `Connector ${row.connectorId} is not configured`);
      }
      // The call ends before the transaction's own timeout, counted from its start, so a late
      // remote delete cannot succeed after local status has already rolled back. Waiting for the
      // lock uses that time too: with too little left, the call is not started at all.
      const callMs = REVOKE_CALL_ENDS_BY_MS - (Date.now() - startedAt);
      if (callMs < MIN_REVOKE_CALL_MS) throw new ProviderTransactionBusyError();
      try {
        const signals = [AbortSignal.timeout(callMs)];
        if (context.signal) signals.unshift(context.signal);
        const revokeSignal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
        await connector.revoke(
          connectionRef,
          connectionContext(owner, "connections.revoke", revokeSignal),
        );
      } catch (error) {
        // The row stays as it was when DELETE clearly did not run (including pre-delete list
        // timeouts), and after any failed provider-wide delete: the caller can remove it again.
        if (!accountSpecific || shouldRestoreLocalAfterRemoteRevokeFailure(error)) throw error;
        // A post-delete timeout is ambiguous: the row stays revoked, and because the account
        // may still be active at the provider, its removal commits with the row as a job.
        await deps.jobs.enqueueIn(tx, connectionCleanupJob({ ...scope, ref: connectionRef }));
        // The caller hanging up mid-revoke is one such ending.
        getLogger().warn("connections.revoke remote outcome uncertain; leaving local revoked", {
          ...(context.signal?.aborted ? {} : { error }),
          connectionId: input.connectionId,
          connectorId: row.connectorId,
        });
        return { uncertain: error };
      }
      return {};
    },
  );

  if (snapshot) await publishConnectionChange(deps, context.actor, organizationId);
  if ("uncertain" in outcome) throw outcome.uncertain;
  return { ok: true as const };
}
