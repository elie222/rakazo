import { purgeClearedConversationMemory } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

export function purgeClearedThreadMemory(
  deps: Pick<RouterDeps, "prisma" | "memoryProviders">,
  actor: Actor,
  target: Parameters<typeof purgeClearedConversationMemory>[2],
  historyCompactionGeneration: number,
): Promise<void> {
  return purgeClearedConversationMemory(
    deps,
    computerContext(
      actor,
      target.kind === "bot" ? target.botId : (target.memberBotIds[0] ?? ""),
      `thread-clear:${target.threadId}`,
    ),
    target,
    historyCompactionGeneration,
  );
}
