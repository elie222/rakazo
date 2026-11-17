import { ClientError, retry } from "@rakazo/core";
import type { HeldLease, Prisma, PrismaClient } from "@rakazo/db";
import {
  assertLeaseHeld,
  claimCheckoutLease,
  isLockTimeout,
  LeaseHeldError,
  LeaseLostError,
  lockCheckoutLease,
  releaseCheckoutLease,
  renewCheckoutLease,
  withLease,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

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
 * `underLease` runs writes that must not outlive the lease. compat-shim(after v0.11.0): the
 * lease also holds the billing account's checkout claim, which the previous release takes
 * instead, so the two keep out of each other during a deploy.
 */
export async function withCheckoutLease<T>(
  prisma: PrismaClient,
  organizationId: string,
  work: (underLease: UnderLease) => Promise<T>,
  /** Undoes `work`'s result when the lease turns out lost after it, before the error is thrown. */
  discard?: (result: T) => Promise<void>,
) {
  const deadline = Date.now() + CHECKOUT_LEASE_MS;
  const attempt = () => {
    let claimId: string | null = null;
    // The claim's row stays locked until the writes commit, so no claimant takes it meanwhile.
    const underLease =
      (lease: HeldLease): UnderLease =>
      (write) =>
        prisma
          .$transaction(async (tx) => {
            if (!(await lockCheckoutLease(tx, organizationId, claimId!)))
              throw new BillingBusyError();
            await assertLeaseHeld(tx, lease);
            return write(tx);
          })
          .catch((error: unknown) => {
            // A write that waited too long on another lock rolled back: busy, like a lost lease.
            if (isLockTimeout(error) || error instanceof LeaseLostError)
              throw new BillingBusyError({ cause: error });
            throw error;
          });
    return withLease(
      prisma,
      `billing-checkout:${organizationId}`,
      {
        ttlMs: CHECKOUT_LEASE_MS,
        // A provider operation can outlast one lease period, so the claim is kept fresh with the
        // lease; a deletion's cancellation then waits for the operation instead of taking over.
        // A renewal racing the release below finds the claim already given back: not a loss.
        onRenew: async () => {
          const held = claimId;
          if (!held) return true;
          return (
            (await renewCheckoutLease(prisma, organizationId, held, CHECKOUT_LEASE_MS)) ||
            claimId !== held
          );
        },
      },
      async (lease) => {
        claimId = await claimCheckoutLease(prisma, organizationId, CHECKOUT_LEASE_MS);
        if (!claimId) throw new LeaseHeldError(lease.key);
        try {
          // Cut off while the claim was being taken: give it back rather than leave it to lapse.
          lease.signal.throwIfAborted();
          const result = await work(underLease(lease));
          // A cancellation that took the lease or the previous release's claim over expired the
          // sessions open at that moment, so a session created after it must not be handed back.
          await prisma
            .$transaction(async (tx) => {
              await assertLeaseHeld(tx, lease);
              if (!(await lockCheckoutLease(tx, organizationId, claimId!))) {
                throw new BillingBusyError();
              }
            })
            .catch(async (error: unknown) => {
              await discard?.(result);
              if (isLockTimeout(error)) throw new BillingBusyError({ cause: error });
              throw error;
            });
          return result;
        } finally {
          const held = claimId;
          claimId = null;
          await bestEffort(
            "release checkout claim",
            releaseCheckoutLease(prisma, organizationId, held),
          );
        }
      },
    );
  };
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
