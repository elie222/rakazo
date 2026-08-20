import type { PrismaClient } from "./client.js";

export function findWorkspaceMemoryConfig(prisma: PrismaClient, workspaceId: string) {
  return prisma.workspaceMemoryConfig.findUnique({ where: { workspaceId } });
}

export function effectiveMemoryScope(
  botScope: string | null,
  defaultScope: string,
): "isolated" | "shared" {
  const scope = botScope ?? defaultScope;
  return scope === "shared" ? "shared" : "isolated";
}

export function supermemoryContainerTagFor(
  scope: "isolated" | "shared",
  botId: string,
  workspaceId: string,
): string {
  return scope === "shared" ? `rakazo:workspace:${workspaceId}` : `rakazo:${botId}`;
}
