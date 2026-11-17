import { deferred } from "@rakazo/core/test-async";
import type { Prisma, PrismaClient } from "@rakazo/db";

type UpdateManyArgs = Parameters<PrismaClient["billingAccount"]["updateMany"]>[0];
type Queries = Pick<PrismaClient, "$executeRaw">;

/**
 * `prisma`, plus a promise that settles once a checkout attempt finds the lease, or the previous
 * release's claim, held by another attempt: that attempt is then queued behind the holder, so a
 * test can release the holder without guessing how long the queued attempt takes to get there.
 */
export function watchCheckoutLeaseClaims(prisma: PrismaClient) {
  const leaseRefused = deferred();
  const watched = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === "$queryRaw") {
        return async (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
          const rows = await target.$queryRaw<unknown[]>(query, ...values);
          const text = "sql" in query ? query.sql : query.join("");
          if (text.includes('INSERT INTO "leases"') && rows.length === 0) leaseRefused.resolve();
          return rows;
        };
      }
      if (property !== "billingAccount") return Reflect.get(target, property, receiver);
      return new Proxy(target.billingAccount, {
        get(accounts, method, accountsReceiver) {
          if (method !== "updateMany") return Reflect.get(accounts, method, accountsReceiver);
          return async (args: UpdateManyArgs) => {
            const result = await accounts.updateMany(args);
            // Only a claim writes a new claim id; a release clears it and a renewal keeps it.
            if (typeof args.data.checkoutLeaseId === "string" && result.count === 0)
              leaseRefused.resolve();
            return result;
          };
        },
      });
    },
  });
  return { prisma: watched, leaseRefused: leaseRefused.promise };
}

/** Lets the organization's checkout lease and claim lapse, as a holder that stalled would. */
export function expireCheckoutLease(prisma: Queries, organizationId: string) {
  return prisma.$executeRaw`
    WITH "claim" AS (
      UPDATE "billing_accounts" SET "checkoutLeaseExpiresAt" = 'epoch'
      WHERE "organizationId" = ${organizationId}
    )
    UPDATE "leases" SET "expiresAt" = 'epoch' WHERE "key" = ${`billing-checkout:${organizationId}`}`;
}
