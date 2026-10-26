const MAX_TRANSACTION_ATTEMPTS = 3;
const RETRYABLE_DATABASE_CODES = new Set(["40001", "40P01"]);

/**
 * Prisma's P2028 also covers a transaction that expired after running statements; only one
 * that never started (no connection within maxWait) is safe to run again.
 */
const UNSTARTED_TRANSACTION = /Unable to start a transaction in the given time/;

function isRetryableTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof Error && UNSTARTED_TRANSACTION.test(error.message)) return true;
  if (!("code" in error)) return false;
  const prismaError = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (prismaError.code === "P2034") return true;
  const databaseCode = prismaError.meta?.driverAdapterError?.cause?.originalCode;
  return typeof databaseCode === "string" && RETRYABLE_DATABASE_CODES.has(databaseCode);
}

export async function withTransactionRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionConflict(error) || attempt >= MAX_TRANSACTION_ATTEMPTS) {
        throw error;
      }
    }
  }
}
