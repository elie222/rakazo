import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

/** Clear removes conversation-derived memory (summaries and learned turns) of the cleared chat's
 * generation, and again of the one before it. clearThread returns the generation from before its
 * increment, so the new chat's turns use the next one and are never purged here. Durable memories
 * remain in their Space-private containers. Best effort throughout: the conversation rows are
 * already deleted, so failing the clear here would help nothing — a failed purge only leaves
 * stale memory recallable. */
export async function purgeClearedConversationMemory(
  deps: { prisma: PrismaClient; memoryProviders: MemoryProviderResolver },
  context: AdapterContext,
  target:
    | { kind: "bot"; botId: string; threadId: string }
    | { kind: "group"; memberBotIds: string[]; threadId: string },
  historyCompactionGeneration: number,
): Promise<void> {
  const configuredMemory = await deps.memoryProviders.resolve(context.spaceId).catch((error) => {
    getLogger().error("semantic memory resolution after thread clear failed", error);
    return null;
  });
  if (!configuredMemory) return;
  // Group chats only feed memory through learned turns, which are keyed by thread. Providers that
  // purge by thread are purged even with learning off now, since earlier turns may be stored;
  // others key history by bot and generation alone, so purging a group's generations there would
  // delete the member bots' direct-chat summaries. A bot removed from the group still learned
  // from it, and its runs outlive the clear.
  let botIds: string[] = [];
  if (target.kind === "bot") {
    botIds = [target.botId];
  } else if (configuredMemory.provider.describe().capabilities.purgesByThread === true) {
    const ranHere = await deps.prisma.run
      .findMany({
        where: { threadId: target.threadId },
        distinct: ["botId"],
        select: { botId: true },
      })
      .catch((error) => {
        // Still purge the current members.
        getLogger().error("listing the bots that ran in a cleared group chat failed", error);
        return [];
      });
    botIds = [...new Set([...target.memberBotIds, ...ranHere.map((run) => run.botId)])];
  }
  await Promise.all(
    botIds.map(async (botId) => {
      try {
        const purged = await configuredMemory.provider.purgeHistory(
          {
            botId,
            threadId: target.threadId,
            generations: [
              Math.max(0, historyCompactionGeneration - 1),
              historyCompactionGeneration,
            ],
          },
          { ...context, botId, operationId: `thread-clear:${target.threadId}` },
        );
        if (!purged.ok) {
          getLogger().error("semantic memory purge after thread clear failed", purged.error);
        }
      } catch (error) {
        getLogger().error("semantic memory purge after thread clear failed", error);
      }
    }),
  );
}
