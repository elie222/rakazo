import type {
  AdapterContext,
  SemanticMemoryCapabilities,
  SemanticMemoryForgetRequest,
  SemanticMemoryProvider,
  SemanticMemoryPurgeHistoryRequest,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import type { RembricConnection } from "./rembric-client.js";
import {
  callRembric,
  classifyRembricConnectionSettings,
  currentRembricProject,
  nonempty,
  REMBRIC_REQUEST_ERROR,
  record,
  rembricEndpoint,
} from "./rembric-client.js";
import { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";

export {
  classifyRembricConnectionSettings,
  rembricRequiresPrivateEndpoint,
  revalidateRembricSettings,
} from "./rembric-client.js";
export const REMBRIC_PROVIDER_ID = "rembric";
export const REMBRIC_CAPABILITIES = {
  recall: true,
  save: true,
  purgeHistory: true,
  sharedScope: true,
  isolatedScope: false,
} as const satisfies SemanticMemoryCapabilities;
const SHARED_ONLY_ERROR = "Rembric only supports shared (Space) memory";

export async function prepareRembricConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: { allowPrivateEndpoint?: boolean; spaceId?: string },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const spaceId = options?.spaceId;
  if (
    !spaceId ||
    !/^[a-zA-Z0-9_-]+$/.test(spaceId) ||
    (settings.spaceId !== undefined && settings.spaceId !== spaceId)
  ) {
    throw new Error("A matching trusted Space is required for Rembric.");
  }
  const classified = await classifyRembricConnectionSettings({ ...settings, spaceId });
  if (classified.endpointTrust === "private" && options?.allowPrivateEndpoint !== true) {
    throw new MemoryProviderPrivateEndpointRequiredError();
  }
  if (!nonempty(credentials.token)) throw new Error("Rembric token is required.");
  const connection: RembricConnection = {
    endpoint: classified.endpoint!,
    spaceId,
    projectId: "",
    token: credentials.token.trim(),
    endpointTrust: classified.endpointTrust,
  };
  let projectId: string;
  try {
    projectId = await currentRembricProject(
      connection,
      undefined,
      options?.allowPrivateEndpoint === true,
    );
  } catch {
    throw new Error(
      "Rembric project access could not be verified; check the endpoint, pre-created Space project and token.",
    );
  }
  return {
    settings: {
      endpoint: connection.endpoint,
      spaceId,
      projectId,
      ...(classified.endpointTrust === "private" ? { endpointTrust: "private" } : {}),
    },
    credentials: { token: connection.token },
  };
}

export function createRembricProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): RembricMemoryProvider {
  const spaceId = settings.spaceId ?? "";
  const endpoint = rembricEndpoint(settings.endpoint ?? "");
  if (!nonempty(spaceId) || !nonempty(settings.projectId) || !nonempty(credentials.token))
    throw new Error("Rembric project binding and token are required.");
  return new RembricMemoryProvider({
    endpoint,
    spaceId,
    projectId: settings.projectId,
    token: credentials.token,
    endpointTrust: settings.endpointTrust,
  });
}

export class RembricMemoryProvider implements SemanticMemoryProvider {
  constructor(private readonly connection: RembricConnection) {}

  describe() {
    return {
      id: REMBRIC_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: REMBRIC_CAPABILITIES,
    };
  }

  private guard(scope: string, context: AdapterContext): string | null {
    if (scope !== "shared") return SHARED_ONLY_ERROR;
    if (context.spaceId !== this.connection.spaceId)
      return "Rembric connection belongs to another Space.";
    return null;
  }

  private ownedMemory(value: unknown): Record<string, unknown> {
    const row = record(value);
    if (
      !nonempty(row.id) ||
      !nonempty(row.title) ||
      !nonempty(row.content) ||
      row.projectId !== this.connection.projectId ||
      (row.scope !== undefined && row.scope !== "project") ||
      (row.status !== undefined && row.status !== "active") ||
      row.truncated ||
      row.headTruncated
    ) {
      throw new Error(REMBRIC_REQUEST_ERROR);
    }
    return row;
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    const error = this.guard(request.scope, context);
    if (error) return { ok: false, error };
    if (!nonempty(request.query) || !Number.isFinite(request.limit) || request.limit < 1)
      return { ok: false, error: "A query and positive recall limit are required." };
    try {
      await currentRembricProject(this.connection, context.signal);
      const limit = Math.min(200, Math.floor(request.limit));
      const result = await callRembric(
        this.connection,
        "memory.search",
        { query: request.query, status: "active", limit },
        context.signal,
      );
      if (
        !Array.isArray(result.memories) ||
        result.count !== result.memories.length ||
        result.memories.length > limit ||
        (result.abstained !== undefined && typeof result.abstained !== "boolean") ||
        result.widened === true ||
        (result.searchedProjects !== undefined &&
          (!Array.isArray(result.searchedProjects) ||
            result.searchedProjects.some(
              (slug) => slug !== new URL(this.connection.endpoint).pathname.slice("/mcp/".length),
            )))
      )
        throw new Error(REMBRIC_REQUEST_ERROR);
      const memories = result.memories.map((value) => this.ownedMemory(value));
      if (result.abstained === true) return { ok: true, value: [] };
      // Rembric provides ranked order but no similarity score. Zero means unspecified,
      // not a fabricated similarity; never use lastSeenAt as an update timestamp.
      return {
        ok: true,
        value: memories.map((row) => ({
          id: row.id as string,
          memory: row.content as string,
          score: 0,
          entity: `space-${this.connection.spaceId}`,
        })),
      };
    } catch {
      return { ok: false, error: REMBRIC_REQUEST_ERROR };
    }
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // Local history CAS already succeeded; history is never durable shared memory.
    if (request.source.kind === "history") return { ok: true, value: undefined };
    const error = this.guard(request.scope, context);
    if (error) return { ok: false, error };
    const content = request.content.trim();
    if (!content) return { ok: false, error: "Memory content is required." };
    try {
      await currentRembricProject(this.connection, context.signal);
      const result = await callRembric(
        this.connection,
        "memory.save",
        {
          type: "project",
          title: content.slice(0, 100),
          content,
          tags: ["rakazo"],
        },
        context.signal,
      );
      if (
        !nonempty(result.id) ||
        !nonempty(result.status) ||
        !nonempty(result.createdAt) ||
        !Array.isArray(result.candidates) ||
        typeof result.judgmentRequired !== "boolean" ||
        !Number.isInteger(result.candidatesDetected) ||
        (result.candidatesDetected as number) < result.candidates.length
      )
        throw new Error(REMBRIC_REQUEST_ERROR);
      for (const candidate of result.candidates) {
        const row = record(candidate);
        if (
          !nonempty(row.judgmentId) ||
          !nonempty(row.targetId) ||
          typeof row.title !== "string" ||
          typeof row.snippet !== "string" ||
          typeof row.similarity !== "number" ||
          !Number.isFinite(row.similarity) ||
          typeof row.source !== "string" ||
          (row.topicKey !== null && typeof row.topicKey !== "string")
        )
          throw new Error(REMBRIC_REQUEST_ERROR);
      }
      // Candidates require semantic judgment. Saving never silently adjudicates them.
      return { ok: true, value: undefined };
    } catch {
      return { ok: false, error: REMBRIC_REQUEST_ERROR };
    }
  }

  async forget(
    request: SemanticMemoryForgetRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ id: string; expired: boolean; reason: string | null }>> {
    const error = this.guard(request.scope, context);
    if (error) return { ok: false, error };
    if (request.entity !== undefined && request.entity !== `space-${this.connection.spaceId}`)
      return { ok: false, error: "That memory belongs to another Space." };
    const id = request.id.trim();
    if (!id) return { ok: false, error: "Memory id is required." };
    try {
      await currentRembricProject(this.connection, context.signal);
      const batch = await callRembric(
        this.connection,
        "memory.get_batch",
        { ids: [id] },
        context.signal,
      );
      if (
        !Array.isArray(batch.errors) ||
        batch.errors.length !== 0 ||
        batch.total !== 1 ||
        batch.nextOffset !== null ||
        !Array.isArray(batch.memories) ||
        batch.memories.length !== 1
      )
        throw new Error(REMBRIC_REQUEST_ERROR);
      const memory = this.ownedMemory(batch.memories[0]);
      if (memory.id !== id) throw new Error(REMBRIC_REQUEST_ERROR);
      const archived = await callRembric(this.connection, "memory.archive", { id }, context.signal);
      if (archived.ok !== true || archived.id !== id || archived.status !== "archived")
        throw new Error(REMBRIC_REQUEST_ERROR);
      // Archive retires the fact; it does not erase Rembric's retained history.
      return { ok: true, value: { id, expired: true, reason: null } };
    } catch {
      return { ok: false, error: REMBRIC_REQUEST_ERROR };
    }
  }

  async purgeHistory(
    _request: SemanticMemoryPurgeHistoryRequest,
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    return { ok: true, value: undefined };
  }
}
