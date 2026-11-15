import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type {
  AdapterContext,
  BackgroundJobPayloads,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import {
  ConnectorAuthUnavailableError,
  connectionCleanupJob,
  connectionCleanupJobKey,
} from "@rakazo/adapter-kit";
import type { ConnectionCleanupOutcome } from "@rakazo/adapters";
import {
  authorizationInUse,
  CONNECTION_CLEANUP_BACKUP_MS,
  connectionCleanupRetryAt,
  dropLeftover,
  dropLeftoverAuthorization,
  leftoverAuthorization,
  lockProviderConnectionScope,
  pickReusableConnection,
  prepareManagedConnectorForTransaction,
  providerLockTransaction,
  providerScopeKey,
  sanitizeIntegrationError,
  tryLockProviderConnectionScope,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { isIntegrationProviderId } from "@rakazo/contracts";
import { IsolationError, ProviderTransactionBusyError, recordSecurityEvent } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { RouterDeps } from "./router.js";
import { connectionCreatedEvent } from "./security-audit.js";

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

/** How long a poll of connections/complete waits for the slot before reporting the row as is. */
const COMPLETE_POLL_SLOT_WAIT_MS = 2_000;

export function connectionContext(
  actor: Pick<Actor, "spaceId" | "userId">,
  operationId: string,
  signal?: AbortSignal,
): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: signal ?? new AbortController().signal,
  };
}

/**
 * Removes what a begin whose result was not saved left at the provider. The keyed backup job is
 * the durable record: only a finished removal deletes it, and an attempt that failed, found the
 * scope busy or could not decide yet hands over to it. The attempt itself takes the scope's
 * provider lock and leaves alone what an active row has saved, as the job does. Never rejects,
 * so the caller's own error is the one reported.
 */
async function removeLeftoverAuthorization(
  deps: Pick<RouterDeps, "prisma" | "jobs">,
  connector: ManagedConnectorProvider,
  leftover: BackgroundJobPayloads["connection.cleanup"],
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
  let outcome: ConnectionCleanupOutcome;
  try {
    // Its own time budget, not the request signal: a caller that hangs up must not cut it short.
    outcome = await dropLeftoverAuthorization(
      deps.prisma,
      connector,
      leftover,
      "connections.begin",
    );
  } catch (error) {
    getLogger().warn("connections.begin leftover cleanup failed; retrying", { error, ...where });
    await handOver();
    return;
  }
  if (outcome !== "done") {
    await handOver(connectionCleanupRetryAt(outcome));
    return;
  }
  await bestEffort(
    "delete the finished connection cleanup's backup job",
    deps.jobs.cancel(connectionCleanupJobKey(leftover)),
  );
}

function cleanupBackupAt(): Date {
  return new Date(Date.now() + CONNECTION_CLEANUP_BACKUP_MS);
}

/**
 * Whether the row holds a begin's result although saving it reported a failure: a commit can
 * land without its answer arriving. A read that fails too settles nothing, so it is `unknown`,
 * never `unsaved`: the row may refer to the authorization.
 */
async function beginResultSaved(
  deps: Pick<RouterDeps, "prisma">,
  actor: Pick<Actor, "spaceId" | "userId">,
  connectionId: string,
  state: string,
): Promise<"saved" | "unsaved" | "unknown"> {
  try {
    const saved = await deps.prisma.connection.count({
      where: {
        id: connectionId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        providerRef: state,
        status: { in: ["connected", "pending", "error"] },
      },
    });
    return saved > 0 ? "saved" : "unsaved";
  } catch (error) {
    getLogger().warn("connections.begin could not check whether its result was saved", { error });
    return "unknown";
  }
}

/**
 * A begin that cannot tell whether its result was saved removes nothing itself: the row may
 * refer to the authorization. The job decides once it can read the rows under the provider lock.
 */
async function leaveLeftoverToJob(
  deps: Pick<RouterDeps, "jobs">,
  leftover: BackgroundJobPayloads["connection.cleanup"],
): Promise<void> {
  try {
    await deps.jobs.enqueue(connectionCleanupJob(leftover));
  } catch (error) {
    // Deleting an authorization that is in use is the greater harm, so it is left where it is.
    getLogger().error(
      "connections.begin could not tell whether its result was saved, and has no backup job; if no connection uses the authorization, remove it at the provider by hand",
      error,
      {
        spaceId: leftover.spaceId,
        userId: leftover.userId,
        connectorId: leftover.connectorId,
        provider: leftover.provider,
        ...(leftover.ref ? { providerRef: leftover.ref } : {}),
      },
    );
  }
}

export async function beginConnection(
  deps: RouterDeps,
  context: { actor: Actor; signal?: AbortSignal },
  input: { connectorId: string; provider: string; displayName: string },
) {
  const connector =
    deps.integrationSettings && isIntegrationProviderId(input.connectorId)
      ? await deps.integrationSettings.resolve(input.connectorId)
      : deps.connectors.managed(input.connectorId);
  if (!connector) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Connector ${input.connectorId} is not configured`,
    });
  }
  // The row belongs to this attempt until a revoke takes it or a later begin reuses it.
  const attempt = randomUUID();
  // Share the revoke scope lock so a slug-wide remote delete cannot miss a
  // row that is inserted after SELECT FOR UPDATE and before remote revoke.
  // Complete and revoke hold that lock across provider calls, so wait as long as they may.
  const row = await providerLockTransaction(
    deps.prisma,
    providerScopeKey(context.actor, input.connectorId, input.provider),
    async (tx) => {
      await lockProviderConnectionScope(tx, context.actor, input.connectorId, input.provider);
      const existing = await tx.connection.findMany({
        where: {
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          connectorId: input.connectorId,
          provider: input.provider,
        },
        select: { id: true, status: true },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      });
      const reusable = pickReusableConnection(existing);
      if (reusable) {
        return tx.connection.update({
          where: { id: reusable.id },
          data: {
            displayName: input.displayName,
            status: "pending",
            providerRef: null,
            metadata: { attempt },
          },
        });
      }
      return tx.connection.create({
        data: {
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          connectorId: input.connectorId,
          provider: input.provider,
          displayName: input.displayName,
          status: "pending",
          metadata: { attempt },
        },
      });
    },
  );
  const ownPendingRow = {
    id: row.id,
    spaceId: context.actor.spaceId,
    userId: context.actor.userId,
    status: "pending",
    metadata: { path: ["attempt"], equals: attempt },
  };
  try {
    const auth = await connector.begin(
      {
        provider: input.provider,
        redirectUrl: `${deps.env.webOrigin}/integrations/callback`,
      },
      connectionContext(context.actor, "connections.begin", context.signal),
    );
    const leftover = leftoverAuthorization(
      connector,
      {
        spaceId: context.actor.spaceId,
        userId: context.actor.userId,
        connectorId: input.connectorId,
        provider: input.provider,
      },
      auth.state,
    );
    // Re-take the provider lock and only advance the row while it is still this attempt's, so
    // a concurrent revoke cannot be overwritten back to pending/connected, and neither can the
    // result of a later begin that reused the row.
    let applied: boolean;
    try {
      applied = await providerLockTransaction(
        deps.prisma,
        providerScopeKey(context.actor, input.connectorId, input.provider),
        async (tx) => {
          await lockProviderConnectionScope(tx, context.actor, input.connectorId, input.provider);
          const updated = await tx.connection.updateMany({
            where: ownPendingRow,
            data: {
              status: auth.authorizationUrl ? "pending" : "connected",
              providerRef: auth.state || null,
              metadata: { state: auth.state, attempt },
            },
          });
          if (updated.count > 0) return true;
          // Lost the row: removing what begin left at the provider commits with that outcome.
          if (leftover)
            await deps.jobs.enqueueIn(tx, connectionCleanupJob(leftover, cleanupBackupAt()));
          return false;
        },
      );
    } catch (error) {
      // The slot stayed busy, or the transaction or its job write failed, after the provider had
      // already answered. When the row does not hold the result, nothing refers to what the
      // provider created, so remove it by its own id, or the app's accounts no local row
      // references, never by a provider-wide slug delete that would take sibling accounts too.
      if (leftover) {
        // A busy slot means the transaction never started, so nothing was saved.
        const result =
          error instanceof ProviderTransactionBusyError
            ? "unsaved"
            : await beginResultSaved(deps, context.actor, row.id, auth.state);
        if (result === "unsaved")
          await removeLeftoverAuthorization(deps, connector, leftover, false);
        else if (result === "unknown") await leaveLeftoverToJob(deps, leftover);
      }
      throw error;
    }
    if (!applied) {
      if (leftover) await removeLeftoverAuthorization(deps, connector, leftover, true);
      throw new IsolationError();
    }
    if (!auth.authorizationUrl) {
      await recordSecurityEvent(connectionCreatedEvent("connections.begin", row.id, context.actor));
    }
    return { connectionId: row.id, authorizationUrl: auth.authorizationUrl };
  } catch (error) {
    if (error instanceof IsolationError) throw error;
    await deps.prisma.connection.updateMany({ where: ownPendingRow, data: { status: "error" } });
    if (error instanceof ProviderTransactionBusyError) throw error;
    if (error instanceof ConnectorAuthUnavailableError) {
      getLogger().warn("connections.begin app has no usable auth config", {
        connectorId: input.connectorId,
        provider: input.provider,
        reason: String(error.cause),
      });
      throw new ORPCError(error.code, { status: 400, message: error.message });
    }
    throw new ORPCError("BAD_REQUEST", { message: sanitizeIntegrationError(error) });
  }
}

export async function completeConnection(
  deps: RouterDeps,
  context: { actor: Actor; signal?: AbortSignal },
  input: { connectionId: string; code?: string },
) {
  const existing = await deps.prisma.connection.findFirst({
    where: {
      id: input.connectionId,
      spaceId: context.actor.spaceId,
      userId: context.actor.userId,
    },
  });
  if (!existing) throw new IsolationError();
  const connector = deps.connectors.managed(existing.connectorId);
  if (!connector) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Connector ${existing.connectorId} is not configured`,
    });
  }
  // Catalog reconciliation connects a row without its account id; the next poll stores it.
  const settling = (row: { status: string; provider: string; providerRef: string | null }) =>
    row.status !== "connected" || row.providerRef === row.provider;
  const prepared = settling(existing)
    ? await prepareManagedConnectorForTransaction(connector)
    : { provider: connector, recheck: undefined };
  const transactionConnector = prepared.provider;
  if (!transactionConnector)
    throw new ORPCError("BAD_REQUEST", { message: "Integration provider is not configured" });
  let row = existing;
  let connectedNow = false;
  if (settling(existing)) {
    // Hold the provider lock across remote completion, account-id resolution,
    // providerRef persistence, and any overlapping revokeUnreferencedAccounts cleanup
    // so a concurrent begin-loss cleanup cannot delete the account we are about
    // to persist. Clients poll, so while another call holds the slot or the lock,
    // report the row as it is instead of waiting on a pooled connection.
    row = await providerLockTransaction(
      deps.prisma,
      providerScopeKey(context.actor, existing.connectorId, existing.provider),
      async (tx) => {
        const locked = await tryLockProviderConnectionScope(
          tx,
          context.actor,
          existing.connectorId,
          existing.provider,
        );
        if (!locked) return existing;
        const current = await tx.connection.findFirst({
          where: {
            id: existing.id,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!current) throw new IsolationError();
        if (prepared.recheck && !(await prepared.recheck(tx))) {
          throw new ORPCError("CONFLICT", {
            message: "Integration credentials changed; retry.",
          });
        }
        if (!settling(current)) return current;
        if (current.status === "revoked") {
          // Authorization URLs from a revoke-win begin can still finish
          // remotely. Cancel leftover authorization-request ids, or drop slug-scoped
          // remotes no active local row still references, before rejecting.
          // Not the request signal: clients abort a poll they no longer need, and
          // that must not cut short removing the leftover remote account.
          const revokedContext = connectionContext(context.actor, "connections.complete");
          const pendingRef = current.providerRef?.trim();
          const scope = {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            connectorId: existing.connectorId,
            provider: existing.provider,
          };
          // The row's own request or account unless an active row has saved it since, or the
          // app's accounts no active row references.
          const cleanup: BackgroundJobPayloads["connection.cleanup"] =
            pendingRef && pendingRef !== current.provider ? { ...scope, ref: pendingRef } : scope;
          try {
            const outcome = await dropLeftover(tx, transactionConnector, cleanup, revokedContext);
            // A sibling still connecting may own any of the accounts. Nothing polls this row
            // again, so a job removes the unreferenced ones once the sibling has saved its own.
            if (outcome === "undecided")
              await deps.jobs.enqueueIn(
                tx,
                connectionCleanupJob(cleanup, connectionCleanupRetryAt("undecided")),
              );
          } catch (error) {
            const where = {
              connectionId: current.id,
              connectorId: existing.connectorId,
              provider: existing.provider,
            };
            // The row stays revoked and nothing polls it again, so a job retries the removal.
            // Not with this transaction: the failure may have been its own.
            try {
              await deps.jobs.enqueue(connectionCleanupJob(cleanup));
              getLogger().warn("connections.complete remote cleanup failed for revoked row", {
                error,
                ...where,
              });
            } catch (unrecorded) {
              getLogger().error(
                "connections.complete could not record its cleanup; remove the authorization at the provider by hand",
                unrecorded,
                { ...where, ...(cleanup.ref ? { providerRef: cleanup.ref } : {}) },
              );
              throw new ORPCError("BAD_REQUEST", { message: sanitizeIntegrationError(error) });
            }
          }
          // A newer attempt or a removal superseded this one. Report it so the
          // caller stops polling instead of retrying an error.
          return current;
        }

        const adapterContext = connectionContext(
          context.actor,
          "connections.complete",
          context.signal,
        );
        if (input.code && current.status !== "connected") {
          const state = current.providerRef ?? current.provider;
          try {
            await transactionConnector.complete({ state, code: input.code }, adapterContext);
          } catch (error) {
            throw new ORPCError("BAD_REQUEST", { message: sanitizeIntegrationError(error) });
          }
        }
        const ready = await transactionConnector.connectionReady(adapterContext, current.provider);
        if (!ready) return current;

        // Browser OAuth stores a connection-request id in providerRef from
        // begin. Resolve it to the connected-account id so revoke deletes the
        // right remote authorization. Prefer an account id not already used
        // by a sibling row for the same provider.
        const resolveAccountId = (ref: string | null | undefined, excludeIds: string[]) =>
          transactionConnector.resolveConnectedAccountId?.(
            context.actor.userId,
            existing.provider,
            ref,
            excludeIds,
            context.actor.spaceId,
          );
        let resolvedAccountId: string | undefined;
        if (transactionConnector.resolveConnectedAccountId) {
          const siblings = await tx.connection.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              connectorId: existing.connectorId,
              provider: existing.provider,
              id: { not: existing.id },
              status: { in: ["connected", "pending", "error"] },
            },
            select: { providerRef: true, status: true },
          });
          // Exclude concrete account ids only. A pending sibling may still
          // store a slug or authorization-request id; passing those raw refs
          // would not match remote account ids and can let this row adopt the
          // sibling's account. If a sibling ref cannot be resolved yet, leave
          // this row pending so a later complete can re-resolve safely.
          const excludeIds: string[] = [];
          try {
            for (const sibling of siblings) {
              const ref = sibling.providerRef?.trim();
              // Slug-only refs cannot identify a concrete remote account; resolving
              // them would pick an arbitrary ACTIVE id and over-exclude.
              if (!ref || ref === existing.provider) {
                // A connected row has no claim on a newer account a sibling may have just authorized.
                if (current.status === "connected" && sibling.status === "pending") return current;
                continue;
              }
              const resolvedSiblingId = await resolveAccountId(ref, []);
              if (!resolvedSiblingId) return current;
              excludeIds.push(resolvedSiblingId);
            }
            resolvedAccountId = await resolveAccountId(current.providerRef, excludeIds);
          } catch (error) {
            // Not being able to ask is not "no account": connecting the row now would store a
            // ref revoke cannot target. Leave it for the next poll.
            getLogger().error(
              "connections.complete could not resolve the connected account",
              error,
              {
                connectionId: current.id,
                connectorId: existing.connectorId,
                provider: existing.provider,
              },
            );
            return current;
          }
        }

        // When a resolver exists and providerRef is still a request-scoped
        // id (not the provider slug), require a concrete account id before
        // marking connected — otherwise revoke would delete the wrong ref.
        if (
          transactionConnector.resolveConnectedAccountId &&
          current.providerRef &&
          current.providerRef !== current.provider &&
          !resolvedAccountId
        ) {
          return current;
        }

        const providerRef = resolvedAccountId ?? current.providerRef;
        if (providerRef) {
          const taken = await tx.connection.findFirst({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              connectorId: existing.connectorId,
              provider: existing.provider,
              id: { not: existing.id },
              status: { in: ["connected", "pending", "error"] },
              providerRef,
            },
            select: { id: true },
          });
          if (taken) {
            // Do not mark connected with a request-scoped or shared ref —
            // leave pending so a later complete can re-resolve an unused id.
            return current;
          }
        }
        // Catalog reconciliation does not take the provider lock, so it may have
        // connected this row meanwhile; only the call that changes it records the event.
        const updated = await tx.connection.updateMany({
          where: { id: current.id, status: current.status },
          data: {
            status: "connected",
            ...(providerRef ? { providerRef } : {}),
          },
        });
        connectedNow = updated.count > 0 && current.status !== "connected";
        if (!connectedNow && providerRef) {
          // Reconciliation sets only the status; keep the resolved account id so
          // revoke still deletes the right remote account.
          await tx.connection.updateMany({
            where: { id: current.id, status: "connected" },
            data: { providerRef },
          });
        }
        const next = await tx.connection.findFirst({
          where: {
            id: current.id,
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
          },
        });
        if (!next) throw new IsolationError();
        return next;
      },
      COMPLETE_POLL_SLOT_WAIT_MS,
    ).catch((error: unknown) => {
      if (error instanceof ProviderTransactionBusyError) return existing;
      throw error;
    });
  }
  // Clients poll this procedure, so it records the credential once, on the transition.
  if (connectedNow) {
    await recordSecurityEvent(
      connectionCreatedEvent("connections.complete", row.id, context.actor),
    );
  }
  return {
    id: row.id,
    connectorId: row.connectorId,
    provider: row.provider,
    displayName: row.displayName,
    status: row.status as "pending" | "connected" | "revoked" | "error",
    capabilities: [],
    createdAt: row.createdAt.toISOString(),
  };
}

export async function revokeConnection(
  deps: RouterDeps,
  context: { actor: Actor; signal?: AbortSignal },
  input: { connectionId: string },
) {
  const snapshot = await deps.prisma.connection.findFirst({
    where: {
      id: input.connectionId,
      spaceId: context.actor.spaceId,
      userId: context.actor.userId,
    },
  });
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
      ? providerScopeKey(context.actor, snapshot.connectorId, snapshot.provider)
      : `connection:${input.connectionId}`,
    async (tx): Promise<{ uncertain?: unknown }> => {
      const row = await tx.connection.findFirst({
        where: {
          id: input.connectionId,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        },
      });
      if (!row) return {};

      // Advisory lock covers inserts as well as existing rows. SELECT FOR UPDATE
      // alone misses a concurrent begin that inserts after the lock query.
      await lockProviderConnectionScope(tx, context.actor, row.connectorId, row.provider);
      await tx.$queryRaw`
        SELECT id
        FROM connections
        WHERE "spaceId" = ${context.actor.spaceId}
          AND "userId" = ${context.actor.userId}
          AND "connectorId" = ${row.connectorId}
          AND provider = ${row.provider}
          AND status IN ('connected', 'pending', 'error')
        FOR UPDATE`;

      const updated = await tx.connection.updateMany({
        where: {
          id: row.id,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          status: { in: ["connected", "pending", "error"] },
        },
        data: { status: "revoked" },
      });
      if (updated.count === 0) return {};

      const remaining = await tx.connection.count({
        where: {
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          connectorId: row.connectorId,
          provider: row.provider,
          status: { in: ["connected", "pending"] },
        },
      });
      const connectionRef = row.providerRef || row.provider;
      const accountSpecific = Boolean(row.providerRef && row.providerRef !== row.provider);
      // Account-scoped refs can disconnect one remote authorization while
      // siblings remain. Slug-only legacy rows must wait until they are last,
      // or a provider-wide revoke would drop every account for that app.
      if (!accountSpecific && remaining > 0) return {};
      const scope = {
        spaceId: context.actor.spaceId,
        userId: context.actor.userId,
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
        throw new ORPCError("CONFLICT", {
          message: "Integration credentials changed; retry.",
        });
      }
      const connector = prepared?.provider;
      if (!connector) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Connector ${row.connectorId} is not configured`,
        });
      }
      try {
        // Abort before the 60s Prisma transaction timeout so a late remote
        // delete cannot succeed after local status has already rolled back.
        const signals = [AbortSignal.timeout(45_000)];
        if (context.signal) signals.unshift(context.signal);
        const revokeSignal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
        await connector.revoke(
          connectionRef,
          connectionContext(context.actor, "connections.revoke", revokeSignal),
        );
      } catch (error) {
        // The row stays as it was when DELETE clearly did not run (including pre-delete list
        // timeouts), and after any failed provider-wide delete: the caller can remove it again.
        if (!accountSpecific || shouldRestoreLocalAfterRemoteRevokeFailure(error)) {
          if (error instanceof ORPCError) throw error;
          throw new ORPCError("BAD_REQUEST", { message: sanitizeIntegrationError(error) });
        }
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

  if ("uncertain" in outcome) {
    const error = outcome.uncertain;
    if (error instanceof ORPCError) throw error;
    throw new ORPCError("BAD_REQUEST", { message: sanitizeIntegrationError(error) });
  }
  return { ok: true as const };
}
