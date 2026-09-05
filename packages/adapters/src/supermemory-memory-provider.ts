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
  parseSupermemoryBaseUrl,
  probeSupermemory,
  type SupermemoryConnectionConfig,
  saveSupermemoryMemoryToContainers,
  searchSupermemoryContainers,
} from "./supermemory-client.js";

export const SUPERMEMORY_PROVIDER_ID = "supermemory";
export const SUPERMEMORY_CLOUD_BASE_URL = "https://api.supermemory.ai";

export function supermemoryRequiresDeploymentOwner(settings: Record<string, string>): boolean {
  return settings.mode === "local";
}

function isLoopbackBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function requiredValue(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parseSupermemoryConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SupermemoryConnectionConfig & { mode: "cloud" | "local" } {
  if (settings.mode !== "cloud" && settings.mode !== "local") {
    throw new Error("mode must be cloud or local");
  }
  const mode = settings.mode;
  const apiKey = requiredValue(credentials, "apiKey");
  if (apiKey.length < 8) throw new Error("apiKey must contain at least 8 characters");
  const baseUrl =
    mode === "cloud" ? SUPERMEMORY_CLOUD_BASE_URL : requiredValue(settings, "baseUrl");
  if (mode === "local" && !isLoopbackBaseUrl(baseUrl)) {
    throw new Error("Local mode requires a loopback address (localhost, 127.0.0.1, or ::1).");
  }
  parseSupermemoryBaseUrl(baseUrl);
  return { mode, baseUrl, apiKey };
}

export async function prepareSupermemoryConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const { mode, baseUrl, apiKey } = parseSupermemoryConnection(settings, credentials);
  const probe = await probeSupermemory({ baseUrl, apiKey });
  if (!probe.ok) throw new Error(probe.error);
  return { settings: { mode, baseUrl }, credentials: { apiKey } };
}

export function createSupermemoryProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  const { baseUrl, apiKey } = parseSupermemoryConnection(settings, credentials);
  return new SupermemoryMemoryProvider({ baseUrl, apiKey });
}

export function decodeLegacySupermemoryCredentials(
  plaintext: string,
): Record<string, string> | null {
  return plaintext.trim() ? { apiKey: plaintext } : null;
}

function durableContainerTags(scope: DurableMemoryScope, botId: string, spaceId: string): string[] {
  const isolated = `rakazo:${botId}`;
  // This external namespace predates the Space rename. Keep it stable so
  // existing durable memories remain recallable; the identifier is a Space ID.
  return scope === "shared" ? [`rakazo:workspace:${spaceId}`, isolated] : [isolated];
}

function historyContainerTag(botId: string, generation: number): string {
  return `rakazo:${botId}:history:${generation}`;
}

function recallContainerTags(request: SemanticMemoryRecallRequest, spaceId: string): string[] {
  const tags = durableContainerTags(request.scope, request.botId, spaceId);
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
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        sharedScope: true,
      } as const,
    };
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    const result = await searchSupermemoryContainers(
      request.query,
      recallContainerTags(request, context.spaceId),
      this.connection,
      request.limit,
      context.signal,
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
        : durableContainerTags(request.scope, request.botId, context.spaceId);
    const result = await saveSupermemoryMemoryToContainers(
      request.content,
      tags,
      this.connection,
      context.signal,
    );
    return result.ok ? { ok: true, value: undefined } : result;
  }

  async purgeHistory(
    request: { botId: string; generations: number[] },
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    const results = await Promise.all(
      [...new Set(request.generations)].map((generation) =>
        deleteSupermemoryContainer(
          historyContainerTag(request.botId, generation),
          this.connection,
          context.signal,
        ),
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
