import type { PrismaClient } from "@rakazo/db";

/** Instance flag or the current user being the deployment owner. Hostname is not authorization. */
export async function actorMayUsePrivateRemoteMcp(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  actorUserId: string,
  instanceAllowPrivateEndpoint: boolean,
): Promise<boolean> {
  if (instanceAllowPrivateEndpoint) return true;
  const findUnique = prisma.deploymentSettings?.findUnique;
  if (!findUnique) return false;
  const settings = await findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  return settings?.ownerUserId === actorUserId;
}
