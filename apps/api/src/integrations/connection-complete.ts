import type { BackgroundJobPayloads } from "@rakazo/adapter-kit";
import { connectionCleanupJob } from "@rakazo/adapter-kit";
import {
  connectionCleanupRetryAt,
  connectionOwnerWhere,
  connectionProviderWhere,
  dropLeftover,
  loadOrganizationReconnectCheck,
  prepareManagedConnectorForTransaction,
  providerLockTransaction,
  providerScopeKey,
  readHostedSignIn,
  tryLockProviderConnectionScope,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { IsolationError, ProviderTransactionBusyError, recordSecurityEvent } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { connectionCreatedEvent } from "../auth/security-audit.js";
import type { RouterDeps } from "../router.js";
import {
  beginConnection,
  connectionContext,
  connectionFlowOwner,
  expireHostedSignIn,
  requireNoPendingSignIn,
} from "./connection-flows.js";
import { findDuplicateAccount } from "./connection-identity.js";
import {
  connectionDto,
  findManagedConnection,
  publishConnectionChange,
  requireConnectionOrganization,
} from "./connection-ownership.js";
import { recordToolConnected } from "./tool-connect-analytics.js";

/** How long a poll of connections/complete waits for the slot before reporting the row as is. */
const COMPLETE_POLL_SLOT_WAIT_MS = 2_000;

export async function completeConnection(
  deps: RouterDeps,
  context: { actor: Actor; signal?: AbortSignal },
  input: { connectionId: string; code?: string },
) {
  const existing = await findManagedConnection(deps.prisma, context.actor, input.connectionId);
  if (!existing) throw new IsolationError();
  const organizationId = existing.organizationId ?? undefined;
  const owner = connectionFlowOwner(context.actor, organizationId);
  const owned = connectionOwnerWhere(owner);
  const connector = deps.connectors.managed(existing.connectorId);
  if (!connector) {
    throw new ClientError("BAD_REQUEST", `Connector ${existing.connectorId} is not configured`);
  }
  // Catalog reconciliation connects a row without its account id; the next poll stores it.
  const settling = (row: { status: string; provider: string; providerRef: string | null }) =>
    row.status !== "connected" || (!organizationId && row.providerRef === row.provider);
  const prepared = settling(existing)
    ? await prepareManagedConnectorForTransaction(connector)
    : { provider: connector, recheck: undefined };
  const transactionConnector = prepared.provider;
  if (!transactionConnector)
    throw new ClientError("BAD_REQUEST", "Integration provider is not configured");
  let row = existing;
  let connectedNow = false;
  let duplicateFound = false;
  let expiredNow = false;
  if (settling(existing)) {
    // Hold the provider lock across remote completion, account-id resolution,
    // providerRef persistence, and any overlapping revokeUnreferencedAccounts cleanup
    // so a concurrent begin-loss cleanup cannot delete the account we are about
    // to persist. Clients poll, so while another call holds the slot or the lock,
    // report the row as it is instead of waiting on a pooled connection.
    row = await providerLockTransaction(
      deps.prisma,
      providerScopeKey(owner, existing.connectorId, existing.provider),
      async (tx) => {
        const locked = await tryLockProviderConnectionScope(
          tx,
          owner,
          existing.connectorId,
          existing.provider,
        );
        if (!locked) return existing;
        if (organizationId) await requireConnectionOrganization(tx, context.actor, organizationId);
        const current = await tx.connection.findFirst({
          where: {
            id: existing.id,
            ...owned,
          },
        });
        if (!current) throw new IsolationError();
        if (prepared.recheck && !(await prepared.recheck(tx))) {
          throw new ClientError("CONFLICT", "Integration credentials changed; retry.");
        }
        if (!settling(current)) return current;
        if (current.status === "revoked") {
          if (
            organizationId &&
            transactionConnector.listAccountsBeforeSignIn &&
            (!current.providerRef || current.providerRef === current.provider)
          )
            return current;
          // Authorization URLs from a revoke-win begin can still finish
          // remotely. Cancel leftover authorization-request ids, or drop slug-scoped
          // remotes no active local row still references, before rejecting.
          // Not the request signal: clients abort a poll they no longer need, and
          // that must not cut short removing the leftover remote account.
          const revokedContext = connectionContext(owner, "connections.complete");
          const pendingRef = current.providerRef?.trim();
          const scope = {
            ...owner,
            connectorId: existing.connectorId,
            provider: existing.provider,
          };
          // The row's own request or account unless an active row has saved it since, or the
          // app's accounts no active row references.
          const cleanup: BackgroundJobPayloads["connection.cleanup"] & { organizationId?: string } =
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
              throw unrecorded;
            }
          }
          // A newer attempt or a removal superseded this one. Report it so the
          // caller stops polling instead of retrying an error.
          return current;
        }

        const adapterContext = connectionContext(owner, "connections.complete", context.signal);
        const listAccounts =
          transactionConnector.listAccountsBeforeSignIn?.bind(transactionConnector);
        if (organizationId && listAccounts) {
          const expired = await expireHostedSignIn(
            tx,
            deps.jobs,
            { ...owner, organizationId },
            current,
            () => listAccounts(current.provider, adapterContext),
          );
          if (expired) {
            expiredNow = true;
            return expired;
          }
        }

        if (input.code && current.status !== "connected") {
          const state = current.providerRef ?? current.provider;
          await transactionConnector.complete({ state, code: input.code }, adapterContext);
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
            ...(organizationId ? [organizationId] : []),
          );
        let resolvedAccountId: string | undefined;
        if (transactionConnector.resolveConnectedAccountId) {
          // Request-scoped references already identify their own authorization. Resolve
          // them independently, then check whether another row owns the result.
          const correlated = current.providerRef && current.providerRef !== current.provider;
          if (organizationId && !correlated && transactionConnector.cancelAuthorizationRequest)
            return current;
          const siblings = correlated
            ? []
            : await tx.connection.findMany({
                where: {
                  ...owned,
                  connectorId: existing.connectorId,
                  provider: connectionProviderWhere(owner, existing.provider),
                  id: { not: existing.id },
                  status: { in: ["connected", "pending", "error"] },
                },
                select: { provider: true, providerRef: true, status: true },
              });
          // Wait when a sibling's authorization cannot yet be resolved to an account id.
          const priorAccountIds =
            organizationId && !correlated && transactionConnector.listAccountsBeforeSignIn
              ? readHostedSignIn(current).priorAccountIds
              : undefined;
          if (
            organizationId &&
            !correlated &&
            transactionConnector.listAccountsBeforeSignIn &&
            !priorAccountIds
          )
            return current;
          const excludeIds = [...(priorAccountIds ?? [])];
          try {
            for (const sibling of siblings) {
              const ref = sibling.providerRef?.trim();
              // Slug-only refs cannot identify a concrete remote account; resolving
              // them would pick an arbitrary ACTIVE id and over-exclude.
              if (!ref || ref === sibling.provider) {
                // A connected row has no claim on a newer account a sibling may have just authorized.
                if (
                  sibling.status === "pending" &&
                  (current.status === "connected" ||
                    !current.providerRef ||
                    current.providerRef === current.provider)
                )
                  return current;
                continue;
              }
              if (sibling.status === "pending" && transactionConnector.cancelAuthorizationRequest)
                continue;
              if (priorAccountIds?.includes(ref)) continue;
              const resolvedSiblingId = await resolveAccountId(ref, []);
              if (!resolvedSiblingId) return current;
              excludeIds.push(resolvedSiblingId);
            }
            resolvedAccountId = await resolveAccountId(current.providerRef, excludeIds);
            if (!resolvedAccountId && priorAccountIds)
              getLogger().debug("Shared sign-in has no uniquely identifiable new account", {
                connectionId: current.id,
              });
          } catch (error) {
            // Not being able to ask is not "no account": connecting the row now would store a
            // ref revoke cannot target. Leave it for the next poll, which asks again: a warning,
            // since a provider outage repeats it on every poll of every pending connection.
            getLogger().warn("connections.complete could not resolve the connected account", {
              error,
              connectionId: current.id,
              connectorId: existing.connectorId,
              provider: existing.provider,
            });
            return current;
          }
        }

        // When a resolver exists and providerRef is still a request-scoped
        // id (not the provider slug), require a concrete account id before
        // marking connected — otherwise revoke would delete the wrong ref.
        if (
          transactionConnector.resolveConnectedAccountId &&
          (organizationId || (current.providerRef && current.providerRef !== current.provider)) &&
          !resolvedAccountId
        ) {
          return current;
        }

        const providerRef = resolvedAccountId ?? current.providerRef;
        if (providerRef) {
          const taken = await tx.connection.findFirst({
            where: {
              ...owned,
              connectorId: existing.connectorId,
              provider: connectionProviderWhere(owner, existing.provider),
              id: { not: existing.id },
              status: resolvedAccountId ? "connected" : { in: ["connected", "pending", "error"] },
              providerRef,
            },
          });
          if (taken) {
            if (resolvedAccountId && taken.status === "connected") {
              await tx.connection.update({
                where: { id: current.id },
                data: { status: "revoked", providerRef: resolvedAccountId },
              });
              duplicateFound = true;
              return taken;
            }
            return current;
          }
        }
        if (resolvedAccountId) {
          const match = await findDuplicateAccount(
            tx,
            transactionConnector,
            current,
            resolvedAccountId,
            adapterContext,
          );
          if (match === "retry") return current;
          if (match) {
            await tx.connection.update({
              where: { id: current.id },
              data: { status: "revoked", providerRef: resolvedAccountId },
            });
            await deps.jobs.enqueueIn(
              tx,
              connectionCleanupJob({
                ...owner,
                connectorId: current.connectorId,
                provider: current.provider,
                ref: resolvedAccountId,
              }),
            );
            duplicateFound = true;
            return match;
          }
        }
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
            ...owned,
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
    recordToolConnected(deps.analytics, context.actor.userId, row);
  }
  if (connectedNow || duplicateFound || expiredNow)
    await publishConnectionChange(deps, context.actor, organizationId);
  return connectionDto(row, organizationId);
}
export async function reconnectOrganizationConnection(
  deps: RouterDeps,
  context: { actor: Actor; signal?: AbortSignal },
  connectionId: string,
) {
  const row = await findManagedConnection(deps.prisma, context.actor, connectionId);
  if (!row?.organizationId || row.status === "revoked") throw new IsolationError();
  if (row.status === "pending") {
    requireNoPendingSignIn(!row.providerRef);
    const completed = await completeConnection(deps, context, { connectionId });
    if (completed.status === "connected")
      return { connectionId: completed.id, authorizationUrl: null };
    if (completed.status === "revoked") throw new IsolationError();
    requireNoPendingSignIn(completed.status === "pending");
  }
  if (row.status === "connected") {
    const connector = deps.connectors.managed(row.connectorId);
    if (!connector) throw new ClientError("BAD_REQUEST", "Integration provider is not configured");
    const adapterContext = connectionContext(
      connectionFlowOwner(context.actor, row.organizationId),
      "connections.reconnectOrganization",
      context.signal,
    );
    const needsReconnect = await loadOrganizationReconnectCheck(connector, adapterContext);
    if (!needsReconnect(row)) return { connectionId, authorizationUrl: null };
  }
  return beginConnection(deps, context, row, row.organizationId, row);
}
