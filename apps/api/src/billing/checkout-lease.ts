import { ClientError, retry } from "@rakazo/core";
import type { HeldLease, Prisma, PrismaClient } from "@rakazo/db";
import {
  assertLeaseHeld,
  boundLockWaits,
  isLockTimeout,
  LeaseHeldError,
  LeaseLostError,
  withLease,
} from "@rakazo/db";

const CHECKOUT_LEASE_MS = 120_000;
const CHECKOUT_LEASE_POLL_MS = 250;
/** Another checkout, cancellation or plan change holds the organization's billing right now. */
export class BillingBusyError extends ClientError {
  constructor(options?: ErrorOptions) {
    super("CONFLICT", "Billing is busy; try again shortly", "CONFLICT", options);
    this.name = "BillingBusyError";
  }
}

/** Runs `write` in one transaction while this request still holds the checkout lease. */
export type UnderLease = <R>(write: (tx: Prisma.TransactionClient) => Promise<R>) => Promise<R>;

/**
 * Runs `work` holding the organization's checkout lease, one at a time across API instances.
 * `underLease` runs writes that must not outlive the lease.
 */
export async function withCheckoutLease<T>(
  prisma: PrismaClient,
  organizationId: string,
  work: (underLease: UnderLease) => Promise<T>,
  /** Undoes `work`'s result when the lease turns out lost after it, before the error is thrown. */
  discard?: (result: T) => Promise<void>,
) {
  const deadline = Date.now() + CHECKOUT_LEASE_MS;
  const whileHeld = <R>(lease: HeldLease, write: (tx: Prisma.TransactionClient) => Promise<R>) =>
    prisma.$transaction(async (tx) => {
      await boundLockWaits(tx);
      await assertLeaseHeld(tx, lease);
      return write(tx);
    });
  const attempt = () =>
    withLease(
      prisma,
      `billing-checkout:${organizationId}`,
      { ttlMs: CHECKOUT_LEASE_MS },
      async (lease) => {
        const result = await work((write) =>
          whileHeld(lease, write).catch((error: unknown) => {
            // A write that waited too long on another lock rolled back: busy, like a lost lease.
            if (isLockTimeout(error) || error instanceof LeaseLostError)
              throw new BillingBusyError({ cause: error });
            throw error;
          }),
        );
        // A cancellation that took the lease over expired the sessions open at that moment, so a
        // session created after it must not be handed back.
        await whileHeld(lease, async () => undefined).catch(async (error: unknown) => {
          await discard?.(result);
          if (isLockTimeout(error)) throw new BillingBusyError({ cause: error });
          throw error;
        });
        return result;
      },
    );
  try {
    return await retry(attempt, {
      attempts: Number.POSITIVE_INFINITY,
      retryable: (error) => error instanceof LeaseHeldError && Date.now() < deadline,
      delayMs: CHECKOUT_LEASE_POLL_MS,
    });
  } catch (error) {
    if (error instanceof LeaseHeldError || error instanceof LeaseLostError)
      throw new BillingBusyError({ cause: error });
    throw error;
  }
}
