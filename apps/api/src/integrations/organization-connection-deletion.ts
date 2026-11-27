import { connectionCleanupJob } from "@rakazo/adapter-kit";
import {
  CONNECTION_CLEANUP_BACKUP_MS,
  connectionProviderWhere,
  hostedSignInCleanupJob,
  lockProviderConnectionScope,
  providerLockTransaction,
  providerScopeKey,
  readHostedSignIn,
  retryConnectionCleanup,
} from "@rakazo/adapters";
import type { HeldLease } from "@rakazo/db";
import { assertLeaseHeld } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterDeps } from "../router.js";

export async function cleanOrganizationConnections(
  deps: Pick<RouterDeps, "prisma" | "connectors" | "jobs">,
  owner: { organizationId: string; userId: string; spaceId: string },
  lease: HeldLease,
) {
  const { organizationId } = owner;
  const providers = await deps.prisma.connection.findMany({
    where: { organizationId, providerRef: { not: null } },
    distinct: ["provider"],
    select: { provider: true },
  });
  for (const provider of new Set(providers.map((row) => row.provider.toLowerCase()))) {
    lease.signal.throwIfAborted();
    const cleanups = await providerLockTransaction(
      deps.prisma,
      providerScopeKey(owner, "", provider),
      async (tx) => {
        await lockProviderConnectionScope(tx, owner, "", provider);
        await assertLeaseHeld(tx, lease);
        const where = { organizationId, provider: connectionProviderWhere(owner, provider) };
        const rows = await tx.connection.findMany({
          where: { ...where, providerRef: { not: null } },
        });
        const immediate = [];
        for (const row of rows) {
          if (!row.providerRef) continue;
          const scope = { ...owner, provider: row.provider, connectorId: row.connectorId };
          const hosted = row.providerRef === row.provider;
          if (hosted && row.status !== "connected") {
            const signIn = readHostedSignIn(row);
            if (!signIn) continue;
            const expiry = Date.parse(signIn.expiresAt ?? "");
            // Hosted links cannot be cancelled by id. The job can remove accounts after expiry
            // even when the organization and its connection rows have already been deleted.
            const hasExpiry = Number.isFinite(expiry);
            await deps.jobs.enqueueIn(
              tx,
              hostedSignInCleanupJob(
                {
                  ...scope,
                  connectionId: row.id,
                  removeUnreferenced: true,
                  ...(!hasExpiry && { legacyIssuedAt: row.updatedAt.toISOString() }),
                },
                new Date(hasExpiry ? expiry : Date.now()),
              ),
            );
          } else {
            const cleanup = hosted ? scope : { ...scope, ref: row.providerRef };
            await deps.jobs.enqueueIn(
              tx,
              connectionCleanupJob(cleanup, new Date(Date.now() + CONNECTION_CLEANUP_BACKUP_MS)),
            );
            immediate.push(cleanup);
          }
        }
        await tx.connection.updateMany({
          where: { ...where, status: { not: "revoked" } },
          data: { status: "revoked" },
        });
        return immediate;
      },
    );
    for (const cleanup of cleanups) {
      lease.signal.throwIfAborted();
      await bestEffort(
        "remove deleted organization's authorization",
        retryConnectionCleanup(deps, cleanup, deps.jobs).catch(async (error: unknown) => {
          await deps.jobs.enqueue(connectionCleanupJob(cleanup));
          throw error;
        }),
      );
    }
  }
}
