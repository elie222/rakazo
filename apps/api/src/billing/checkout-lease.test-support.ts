import { deferred } from "@rakazo/core/test-async";
import type { Prisma, PrismaClient } from "@rakazo/db";

type Queries = Pick<PrismaClient, "$executeRaw">;

/**
 * `prisma`, plus a promise that settles once a checkout attempt finds the lease held by another
 * attempt: that attempt is then queued behind the holder, so a test can release the holder
 * without guessing how long the queued attempt takes to get there.
 */
export function watchCheckoutLeaseClaims(prisma: PrismaClient) {
  const leaseRefused = deferred();
  const watched = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== "$queryRaw") return Reflect.get(target, property, receiver);
      return async (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
        const rows = await target.$queryRaw<unknown[]>(query, ...values);
        const text = "sql" in query ? query.sql : query.join("");
        if (text.includes('INSERT INTO "leases"') && rows.length === 0) leaseRefused.resolve();
        return rows;
      };
    },
  });
  return { prisma: watched, leaseRefused: leaseRefused.promise };
}

/** Lets the organization's checkout lease lapse, as a holder that stalled would. */
export function expireCheckoutLease(prisma: Queries, organizationId: string) {
  return prisma.$executeRaw`
    UPDATE "leases" SET "expiresAt" = 'epoch' WHERE "key" = ${`billing-checkout:${organizationId}`}`;
}
