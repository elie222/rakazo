import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsTenant } from "@rakazo/db";

export const MAX_STREAMS_PER_KEY = 5;
/** A stream's lease lasts this long unless renewed, so a dead server frees its slots. */
export const STREAM_LEASE_SECONDS = 60;
const RENEW_MS = 20_000;

function leaseUntil(): Date {
  return new Date(Date.now() + STREAM_LEASE_SECONDS * 1000);
}

/**
 * Takes one of the key's stream slots in Postgres, so the cap holds across every server.
 * Returns the release, or null when the key already holds its limit.
 */
export async function claimStream(
  prisma: PrismaClient,
  actor: Actor,
  credentialId: string,
): Promise<(() => void) | null> {
  const tenant = { spaceId: actor.spaceId, userId: actor.userId };
  const id = await runAsTenant(tenant, () =>
    prisma.$transaction(async (tx) => {
      // Two servers opening the key's sixth stream at once queue here; one of them is refused.
      await tx.$queryRaw`SELECT id FROM service_credentials WHERE id = ${credentialId} FOR UPDATE`;
      await tx.serviceEventStream.deleteMany({
        where: { credentialId, expiresAt: { lte: new Date() } },
      });
      const open = await tx.serviceEventStream.count({ where: { credentialId } });
      if (open >= MAX_STREAMS_PER_KEY) return null;
      const lease = await tx.serviceEventStream.create({
        data: { ...tenant, credentialId, expiresAt: leaseUntil() },
        select: { id: true },
      });
      return lease.id;
    }),
  );
  if (!id) return null;
  // The stream outlives the request, so its queries name their tenant instead of inheriting one.
  const renew = setInterval(() => {
    void runAsTenant(tenant, () =>
      prisma.serviceEventStream.updateMany({ where: { id }, data: { expiresAt: leaseUntil() } }),
    ).catch(() => undefined);
  }, RENEW_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(renew);
    void runAsTenant(tenant, () => prisma.serviceEventStream.deleteMany({ where: { id } })).catch(
      () => undefined,
    );
  };
}
