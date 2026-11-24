import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryForgetRequest,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import { memoryConnectionIdentity } from "../../../memory/memory-provider-descriptor.js";
import {
  assertLocalServiceBaseUrlSync,
  LocalServiceHost,
  localServiceTrust,
  localServiceTrustSettings,
  parseServiceBaseUrl,
  pinLocalServiceHost,
} from "../../../network/local-service-endpoint.js";
import type { ResolveHostname } from "../../../network/network-address.js";
import type { SupermemoryConnectionConfig } from "./supermemory-client.js";
import {
  deleteSupermemoryContainer,
  forgetSupermemoryMemories,
  getSupermemoryMemory,
  MAX_MEMORY_CONTENT_CHARS,
  probeSupermemory,
  SUPERMEMORY_CLOUD_BASE_URL,
  SUPERMEMORY_MEMORY_ID,
  saveSupermemoryMemoryToContainers,
  searchSupermemory,
  searchSupermemoryContainers,
} from "./supermemory-client.js";

export const SUPERMEMORY_PROVIDER_ID = "supermemory";
export { SUPERMEMORY_CLOUD_BASE_URL };

/** A self-hosted server needs the operator's setting unless it was checked to be public. */
export function supermemoryRequiresPrivateEndpoint(settings: Record<string, string>): boolean {
  return settings.mode === "local" && localServiceTrust(settings) === "private";
}

function isSupermemoryCloudBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === new URL(SUPERMEMORY_CLOUD_BASE_URL).origin;
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
  if (mode === "local") {
    // The cloud origin takes the unpinned cloud transport, so it cannot be a local endpoint.
    if (isSupermemoryCloudBaseUrl(baseUrl)) {
      throw new Error("Local mode cannot use the Supermemory Cloud URL.");
    }
    assertLocalServiceBaseUrlSync(baseUrl);
  }
  parseServiceBaseUrl(baseUrl);
  return {
    mode,
    baseUrl,
    apiKey,
    ...(mode === "local" ? { trust: localServiceTrust(settings) } : {}),
  };
}

export async function prepareSupermemoryConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
    fetch?: typeof globalThis.fetch;
  },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const { mode, baseUrl, apiKey } = parseSupermemoryConnection(settings, credentials);
  const pin = mode === "local" ? await pinLocalServiceHost(baseUrl, options) : undefined;
  const connection: SupermemoryConnectionConfig = {
    baseUrl,
    apiKey,
    resolveHostname: options?.resolveHostname,
    fetch: options?.fetch,
    ...pin,
  };
  const probe = await probeSupermemory(connection);
  if (!probe.ok) throw new Error(probe.error);
  // Clearing a conversation deletes its memory, which only owner and admin keys may do.
  // Deleting a fresh random tag checks that without touching anyone's data.
  const deletable = await deleteSupermemoryContainer(
    `rakazo:delete-probe:${randomUUID()}`,
    connection,
  );
  if (!deletable.ok) throw new Error(deletable.error);
  return {
    settings: { mode, baseUrl, ...localServiceTrustSettings(pin) },
    credentials: { apiKey },
  };
}

export function createSupermemoryProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  connectionVersion?: string,
): SemanticMemoryProvider {
  const { baseUrl, apiKey, trust } = parseSupermemoryConnection(settings, credentials);
  return new SupermemoryMemoryProvider({ baseUrl, apiKey, trust }, connectionVersion);
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
  readonly connectionIdentity?: string;
  private readonly localHost?: LocalServiceHost;

  constructor(
    private readonly connection: SupermemoryConnectionConfig,
    connectionVersion?: string,
  ) {
    this.connectionIdentity = memoryConnectionIdentity(connectionVersion, connection.baseUrl);
    if (!isSupermemoryCloudBaseUrl(connection.baseUrl)) {
      this.localHost = new LocalServiceHost(
        connection.baseUrl,
        connection.trust ?? "private",
        connection.resolveHostname,
      );
    }
  }

  private localBaseUrlBlock(): Promise<string | null> {
    return this.localHost?.block() ?? Promise.resolve(null);
  }

  private connectionForRequest(): SupermemoryConnectionConfig {
    return this.localHost?.withPin(this.connection) ?? this.connection;
  }

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
    // Supermemory rejects an empty search query.
    if (!request.query.trim()) return { ok: true, value: [] };
    const blocked = await this.localBaseUrlBlock();
    if (blocked) return { ok: false, error: blocked };
    // Only durable facts are cited: chat summaries rotate with the chat and are not forgotten one by one.
    const durable = durableContainerTags(request.scope, request.botId, context.spaceId);
    const result = await searchSupermemoryContainers(
      request.query,
      recallContainerTags(request, context.spaceId),
      this.connectionForRequest(),
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
            ...(item.id && item.containerTag && durable.includes(item.containerTag)
              ? { id: item.id, entity: item.containerTag }
              : {}),
          })),
        }
      : result;
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    const blocked = await this.localBaseUrlBlock();
    if (blocked) return { ok: false, error: blocked };
    if (
      request.source.kind !== "history" &&
      request.content.trim().length > MAX_MEMORY_CONTENT_CHARS
    ) {
      return {
        ok: false,
        error: `Supermemory save skipped: memory content is longer than ${MAX_MEMORY_CONTENT_CHARS} characters. Save a shorter fact.`,
      };
    }
    const tags =
      request.source.kind === "history"
        ? [historyContainerTag(request.botId, request.source.generation)]
        : durableContainerTags(request.scope, request.botId, context.spaceId);
    const result = await saveSupermemoryMemoryToContainers(
      request.content,
      tags,
      this.connectionForRequest(),
      context.signal,
    );
    return result.ok ? { ok: true, value: undefined } : result;
  }

  /**
   * Supermemory forgets only ids inside the namespace named in the request, so trying each of the
   * bot's recall namespaces cannot reach another bot's memory or another Space's.
   */
  async forget(
    request: SemanticMemoryForgetRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ id: string; expired: boolean; reason: string | null }>> {
    const id = request.id.trim();
    if (!id) return { ok: false, error: "id is required" };
    if (!SUPERMEMORY_MEMORY_ID.test(id)) {
      return { ok: false, error: "Invalid Supermemory memory id." };
    }
    const durable = durableContainerTags(request.scope, request.botId, context.spaceId);
    if (request.entity && !durable.includes(request.entity)) {
      return { ok: false, error: "That memory belongs to another bot or Space." };
    }
    const blocked = await this.localBaseUrlBlock();
    if (blocked) return { ok: false, error: blocked };
    const connection = this.connectionForRequest();
    const done = {
      ok: true as const,
      value: { id, expired: true, reason: request.reason ?? null },
    };
    const tags = request.entity ? [request.entity] : durable;
    const lookups = await Promise.all(
      tags.map((tag) => getSupermemoryMemory(id, tag, connection, context.signal)),
    );
    const index = lookups.findIndex((lookup) => lookup.ok && lookup.value);
    if (index === -1) {
      const failed = lookups.find((lookup) => !lookup.ok);
      if (failed && !failed.ok) return failed;
      return {
        ok: false,
        error:
          "No memory with that id was found in this bot's memory. Pass the entity from its recall citation.",
      };
    }
    const lookup = lookups[index]!;
    const found = lookup.ok ? lookup.value : null;
    // A forgotten memory is kept for its history, so a retried forget ends here as done.
    if (!found || found.forgotten) return done;
    const home = tags[index]!;
    // A shared save stores the fact in two namespaces, and recall cites one. Forget the copies
    // this bot could recall again first, then the cited memory, so a failed forget can be
    // retried with the same id.
    const text = found.memory.trim();
    // One search per namespace keeps the forget bounded.
    for (const tag of durable) {
      const copies = await searchSupermemory(text, tag, connection, undefined, context.signal);
      if (!copies.ok) return copies;
      const ids = copies.results
        .filter((copy) => copy.id && copy.id !== id && copy.memory.trim() === text)
        .map((copy) => copy.id!);
      if (!ids.length) continue;
      const forgotten = await forgetSupermemoryMemories(ids, tag, connection, context.signal);
      if (!forgotten.ok) return forgotten;
    }
    const forgotten = await forgetSupermemoryMemories([id], home, connection, context.signal);
    return forgotten.ok ? done : forgotten;
  }

  async purgeHistory(
    request: { botId: string; generations: number[] },
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    const blocked = await this.localBaseUrlBlock();
    if (blocked) return { ok: false, error: blocked };
    const results = await Promise.all(
      [...new Set(request.generations)].map((generation) =>
        deleteSupermemoryContainer(
          historyContainerTag(request.botId, generation),
          this.connectionForRequest(),
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
