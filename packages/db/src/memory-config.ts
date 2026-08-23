import type { PrismaClient } from "./client.js";

export function findWorkspaceMemoryConfig(
  prisma: Pick<PrismaClient, "workspaceMemoryConfig">,
  workspaceId: string,
) {
  return prisma.workspaceMemoryConfig.findUnique({ where: { workspaceId } });
}

export function effectiveMemoryScope(
  botScope: string | null,
  defaultScope: string,
): "isolated" | "shared" {
  const scope = botScope ?? defaultScope;
  return scope === "shared" ? "shared" : "isolated";
}
