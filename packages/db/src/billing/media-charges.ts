import type { PrismaClient } from "../database/client.js";
import { runAsSystem, runAsSystemInTransaction } from "../database/row-security.js";

/** Hosted media the organization was charged since `since`, in micros. */
export async function mediaChargedMicros(
  prisma: Pick<PrismaClient, "mediaCharge">,
  organizationId: string,
  since: Date,
): Promise<number> {
  const charged = await runAsSystem("media charges across an organization", () =>
    prisma.mediaCharge.aggregate({
      where: { organizationId, createdAt: { gte: since } },
      _sum: { amountMicros: true },
    }),
  );
  return charged._sum.amountMicros ?? 0;
}

/**
 * Charges a hosted generation once per `source`, inside the transaction that stores its output;
 * a repeat for the same source changes nothing.
 */
export async function chargeMedia(
  tx: Pick<PrismaClient, "mediaCharge" | "$queryRaw">,
  charge: { organizationId: string; source: string; kind: string; amountMicros: number },
): Promise<void> {
  await runAsSystemInTransaction(tx, "charge an organization's media balance", () =>
    tx.mediaCharge.createMany({ data: [charge], skipDuplicates: true }),
  );
}
