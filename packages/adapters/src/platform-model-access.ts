import type { PlatformModelAllowlist } from "@rakazo/core";
import { platformModelAllowed } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** An unrestricted deployment avoids identity reads on the model-resolution path. */
export async function canUsePlatformModel(
  prisma: PrismaClient,
  allowlist: PlatformModelAllowlist | undefined,
  userId: string,
): Promise<boolean> {
  if (!allowlist || (Array.isArray(allowlist) && allowlist.length === 0)) return true;
  const [user, settings] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    }),
  ]);
  return platformModelAllowed({
    allowlist,
    email: user?.email ?? "",
    isOwner: settings?.ownerUserId === userId,
  });
}
