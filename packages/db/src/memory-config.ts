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

export function supermemoryContainerTagFor(
  scope: "isolated" | "shared",
  botId: string,
  workspaceId: string,
  historyGeneration = 0,
): string {
  if (scope === "shared") return `rakazo:workspace:${workspaceId}`;
  return historyGeneration > 0 ? `rakazo:${botId}:history:${historyGeneration}` : `rakazo:${botId}`;
}

export function supermemoryContainerTagsFor(
  scope: "isolated" | "shared",
  botId: string,
  workspaceId: string,
  historyGeneration = 0,
): string[] {
  const isolatedTag = supermemoryContainerTagFor("isolated", botId, workspaceId, historyGeneration);
  return scope === "shared"
    ? [supermemoryContainerTagFor("shared", botId, workspaceId), isolatedTag]
    : [isolatedTag];
}
