import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import {
  deleteSupermemoryContainer,
  probeSupermemory,
  type SupermemoryConnectionConfig,
  saveSupermemoryMemoryToContainers,
  searchSupermemoryContainers,
} from "./supermemory-client.js";

export const SUPERMEMORY_PROVIDER_ID = "supermemory";
export const SUPERMEMORY_CLOUD_BASE_URL = "https://api.supermemory.ai";

function durableContainerTags(
  scope: DurableMemoryScope,
  botId: string,
  workspaceId: string,
): string[] {
  const isolated = `rakazo:${botId}`;
  return scope === "shared" ? [`rakazo:workspace:${workspaceId}`, isolated] : [isolated];
}

function historyContainerTag(botId: string, generation: number): string {
  return `rakazo:${botId}:history:${generation}`;
}

function recallContainerTags(request: SemanticMemoryRecallRequest, workspaceId: string): string[] {
  const tags = durableContainerTags(request.scope, request.botId, workspaceId);
  return request.historyGeneration === undefined
    ? tags
    : [...tags, historyContainerTag(request.botId, request.historyGeneration)];
}

export class SupermemoryMemoryProvider implements SemanticMemoryProvider {
  constructor(private readonly connection: SupermemoryConnectionConfig) {}

  describe() {
    return {
      id: SUPERMEMORY_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true },
    };
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    const result = await searchSupermemoryContainers(
      request.query,
      recallContainerTags(request, context.workspaceId),
      this.connection,
    );
    return result.ok
      ? {
          ok: true,
          value: result.results.slice(0, request.limit).map((item) => ({
            memory: item.memory,
            score: item.similarity,
            ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
          })),
        }
      : result;
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    const tags =
      request.source.kind === "history"
        ? [historyContainerTag(request.botId, request.source.generation)]
        : durableContainerTags(request.scope, request.botId, context.workspaceId);
    const result = await saveSupermemoryMemoryToContainers(request.content, tags, this.connection);
    return result.ok ? { ok: true, value: undefined } : result;
  }

  async purgeHistory(
    request: { botId: string; generations: number[] },
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    const results = await Promise.all(
      [...new Set(request.generations)].map((generation) =>
        deleteSupermemoryContainer(historyContainerTag(request.botId, generation), this.connection),
      ),
    );
    const errors = results.filter((result) => !result.ok).map((result) => result.error);
    return errors.length > 0
      ? { ok: false, error: errors.join("; ") }
      : { ok: true, value: undefined };
  }

  static async probe(connection: SupermemoryConnectionConfig) {
    return probeSupermemory(connection);
  }
}
