import { modelRoleConnectionId } from "@rakazo/contracts";
import { availableInSpace } from "@rakazo/db";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import type { RunHold } from "../lifecycle/run-attempt.js";
import type { RunCapabilities, StartedTurnModel } from "./run-assembly-capabilities.js";
import type { RunRecords } from "./run-assembly-records.js";

/** Same reach as the MCP connector: usable servers assigned to the bot or shared with every bot. */
async function verbatimMcpServersForRun(
  prisma: ExecutorDeps["prisma"],
  scope: { botId: string; spaceId: string; userId: string },
) {
  if (!prisma.mcpServer?.findMany) return undefined;
  const servers = await prisma.mcpServer.findMany({
    where: {
      verbatimResults: true,
      enabled: true,
      ...availableInSpace(scope),
      AND: [{ OR: [{ allBots: true }, { assignments: { some: { botId: scope.botId } } }] }],
    },
    select: { id: true, slug: true },
  });
  if (!servers?.length) return undefined;
  return { ids: servers.map((server) => server.id), slugs: servers.map((server) => server.slug) };
}

export async function loadModelFallbacks(
  hold: RunHold,
  parts: { records: RunRecords; model: StartedTurnModel; capabilities: RunCapabilities },
) {
  const { deps, run } = hold;
  const { bot } = parts.records;
  const { backups, runModelId, runModelProvider } = parts.model;
  const { mainRunModel } = parts.capabilities;
  const verbatimMcpServers = await verbatimMcpServersForRun(deps.prisma, {
    botId: bot.id,
    spaceId: run.spaceId,
    userId: run.userId,
  });
  // The running model is not its own backup, unless another account serves it.
  const fallbackModels = (await backups.load()).filter(
    (candidate) =>
      !backups.unavailable.has(candidate) &&
      (candidate.provider !== runModelProvider ||
        candidate.modelId !== runModelId ||
        (modelRoleConnectionId(candidate) !== undefined &&
          modelRoleConnectionId(candidate) !== mainRunModel.connectionId)),
  );
  const fallbackKey = (provider: string, modelId: string, credentialId?: string | null) =>
    JSON.stringify([provider, modelId, credentialId ?? null]);
  const fallbackModelKeys = new Set(
    fallbackModels.map((candidate) =>
      fallbackKey(candidate.provider, candidate.modelId, modelRoleConnectionId(candidate)),
    ),
  );
  const fallbackModelIds = new Set(
    fallbackModels.map((candidate) => fallbackKey(candidate.provider, candidate.modelId)),
  );
  // Provider kind and model id only: custom endpoints are identified by kind, never host.
  const activeModel = { "model.provider": runModelProvider, "model.id": runModelId };
  return {
    verbatimMcpServers,
    fallbackModels,
    fallbackKey,
    fallbackModelKeys,
    fallbackModelIds,
    activeModel,
  };
}

export type ModelFallbacks = Awaited<ReturnType<typeof loadModelFallbacks>>;
