import type { Prisma } from "../database/client.js";
import { personalOrganizationIds } from "../spaces/spaces.js";

/** Identity records that need explicit cleanup before deleting the user. */
export async function clearAccountIdentity(tx: Prisma.TransactionClient, userId: string) {
  const organizationIds = await personalOrganizationIds(tx, userId);
  // Messaging identities are FK-free. Release their unique addresses so they can be linked again.
  await tx.messagingIdentity.deleteMany({ where: { userId } });
  await tx.passkey.deleteMany({ where: { userId } });
  await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
}
