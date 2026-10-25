import { destroyBot } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { createRepos } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

export function createBotRemoval(deps: RouterDeps, repos: ReturnType<typeof createRepos>) {
  const removeBot = async (
    actor: Actor,
    botId: string,
    options: Parameters<typeof destroyBot>[3],
  ) => {
    const bot = await repos.getBot(actor, botId, { includeArchived: true });
    await destroyBot(
      {
        prisma: deps.prisma,
        sandbox: deps.sandbox,
        home: deps.home,
        jobs: deps.jobs,
        artifacts: deps.artifacts,
        dataDir: deps.dataDir,
        messagingInstallations: deps.messagingInstallations,
      },
      bot,
      {
        operationId: "destroy",
        traceId: "destroy",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        signal: new AbortController().signal,
      },
      options,
    );
  };
  return removeBot;
}
