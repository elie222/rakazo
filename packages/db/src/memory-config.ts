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
): string {
  if (scope === "shared") return `rakazo:workspace:${workspaceId}`;
  return `rakazo:${botId}`;
}

export function supermemoryContainerTagsFor(
  scope: "isolated" | "shared",
  botId: string,
  workspaceId: string,
): string[] {
  // Shared durable memories also use a private bot mirror so they remain available if the bot's
  // scope changes later.
  const isolatedTag = supermemoryContainerTagFor("isolated", botId, workspaceId);
  return scope === "shared"
    ? [supermemoryContainerTagFor("shared", botId, workspaceId), isolatedTag]
    : [isolatedTag];
}

/** Conversation-derived summaries are isolated from durable memories so clear can purge safely. */
export function supermemoryHistoryContainerTagFor(
  botId: string,
  historyGeneration: number,
): string {
  return `rakazo:${botId}:history:${historyGeneration}`;
}

export function supermemoryRecallContainerTagsFor(
  scope: "isolated" | "shared",
  botId: string,
  workspaceId: string,
  historyGeneration: number,
): string[] {
  return [
    ...supermemoryContainerTagsFor(scope, botId, workspaceId),
    supermemoryHistoryContainerTagFor(botId, historyGeneration),
  ];
}

export function supermemoryHistoryContainerTagsForClear(
  botId: string,
  historyGenerationAfterClear: number,
): string[] {
  const previousGeneration = Math.max(0, historyGenerationAfterClear - 1);
  return [
    ...new Set([
      supermemoryHistoryContainerTagFor(botId, previousGeneration),
      supermemoryHistoryContainerTagFor(botId, historyGenerationAfterClear),
    ]),
  ];
}
