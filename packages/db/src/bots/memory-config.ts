import type { PrismaClient } from "../database/client.js";

export function findSpaceMemoryConfig(
  prisma: Pick<PrismaClient, "spaceMemoryConfig">,
  spaceId: string,
) {
  return prisma.spaceMemoryConfig.findUnique({ where: { spaceId } });
}

export function effectiveMemoryScope(
  botScope: string | null,
  defaultScope: string,
): "isolated" | "shared" {
  const scope = botScope ?? defaultScope;
  return scope === "shared" ? "shared" : "isolated";
}
