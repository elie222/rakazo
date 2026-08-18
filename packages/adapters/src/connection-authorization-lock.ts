import { performance } from "node:perf_hooks";
import type { Prisma } from "@rakazo/db";

const CONNECTION_LOCK_TIMEOUT_MS = 5_000;
const CONNECTION_OPERATION_TIMEOUT_MS = 70_000;
const CONNECTION_PROVIDER_TIMEOUT_MS = 60_000;
const CONNECTION_SETTLE_BUFFER_MS = 5_000;

export const CONNECTION_OPERATION_TRANSACTION_OPTIONS = {
  maxWait: CONNECTION_LOCK_TIMEOUT_MS,
  timeout: CONNECTION_OPERATION_TIMEOUT_MS,
};

export type ConnectionOperationBudget = {
  deadline: number;
};

export async function beginConnectionOperation(
  tx: Prisma.TransactionClient,
): Promise<ConnectionOperationBudget> {
  const deadline = performance.now() + CONNECTION_OPERATION_TIMEOUT_MS;
  await tx.$queryRaw`
    SELECT set_config('lock_timeout', ${`${CONNECTION_LOCK_TIMEOUT_MS}ms`}, true)
  `;
  return { deadline };
}

export async function acquireSharedConnectionAuthorizationLocks(
  tx: Prisma.TransactionClient,
  userId: string,
  providers: string[],
): Promise<void> {
  const ordered = [...new Set(providers)].sort();
  for (const provider of ordered) {
    const key = `connection:${userId}:${provider}`;
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))
    `;
  }
}

export async function acquireExclusiveConnectionAuthorizationLock(
  tx: Prisma.TransactionClient,
  userId: string,
  provider: string,
): Promise<void> {
  const key = `connection:${userId}:${provider}`;
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
  `;
}

export function connectionOperationSignal(
  budget: ConnectionOperationBudget,
  upstream?: AbortSignal,
): AbortSignal {
  upstream?.throwIfAborted();
  const remaining = Math.min(
    CONNECTION_PROVIDER_TIMEOUT_MS,
    Math.floor(budget.deadline - performance.now() - CONNECTION_SETTLE_BUFFER_MS),
  );
  if (remaining <= 0) throw new Error("Connection operation deadline exhausted");
  const timeout = AbortSignal.timeout(remaining);
  return upstream ? AbortSignal.any([upstream, timeout]) : timeout;
}
