import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
  TurnMemoryCapture,
  TurnMemoryCaptureResult,
  TurnMemoryLayer,
  TurnMemoryLifecycle,
  TurnMemoryRecall,
  TurnMemoryRecallRequest,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { assertLocalServiceBaseUrlSync, pinLocalServiceHost } from "./local-service-endpoint.js";
import {
  classifyMemmyConnectionSettings,
  memmyRequiresPrivateEndpoint,
  normalizeMemmyBaseUrl,
} from "./memmy-connection-trust.js";
import type {
  MemmyClientOptions,
  MemmyNamespace,
  MemmySourceTurnBody,
} from "./memmy-memory-client.js";
import { MemmyMemoryClient } from "./memmy-memory-client.js";
import type { ResolveHostname } from "./network-address.js";
import { egressRefused } from "./network-address.js";
import { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";

export const MEMMY_PROVIDER_ID = "memmy";

/** Memmy's source id for everything Rakazo writes; also its capture-dedupe scope. */
export const MEMMY_SOURCE = "rakazo";
export const DEFAULT_MEMMY_OWNER_ID = "rakazo";
/** Memmy token budget for recalled context. */
export const DEFAULT_MEMMY_CONTEXT_BUDGET = 1800;
export const MEMMY_RECALL_LAYERS: TurnMemoryLayer[] = [
  "procedure",
  "policy",
  "environment",
  "episode",
];
export const MEMMY_TURN_RECALL_LIMIT = 8;
export const MEMMY_COMPLETION_EVIDENCE = "run.completed";
/** Search queries past this add latency without improving the match. */
const MAX_SEARCH_QUERY_CHARS = 8000;
const MAX_TOKEN_CHARS = 4096;
const OWNER_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,256}$/;

interface MemmyConnection {
  baseUrl: string;
  token: string;
  ownerId: string;
  contextBudget: number;
  endpointTrust: "public" | "private";
}

function parseMemmyConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): MemmyConnection {
  const baseUrl = normalizeMemmyBaseUrl(settings.baseUrl);
  const endpointTrust = memmyRequiresPrivateEndpoint({ ...settings, baseUrl })
    ? "private"
    : "public";
  // Metadata names and link-local literals are refused before any request.
  if (endpointTrust === "private") assertLocalServiceBaseUrlSync(baseUrl);
  const token = credentials.token?.trim();
  if (!token) throw new Error("token is required");
  if (token.length > MAX_TOKEN_CHARS)
    throw new Error(`token must be at most ${MAX_TOKEN_CHARS} characters`);
  const ownerId = settings.ownerId?.trim() || DEFAULT_MEMMY_OWNER_ID;
  if (!OWNER_ID_PATTERN.test(ownerId)) {
    throw new Error("ownerId may contain only letters, digits, '.', '_', ':', '@' and '-'");
  }
  const rawBudget = settings.contextBudget?.trim();
  let contextBudget = DEFAULT_MEMMY_CONTEXT_BUDGET;
  if (rawBudget) {
    if (!/^\d{1,6}$/.test(rawBudget) || Number(rawBudget) < 1) {
      throw new Error("contextBudget must be a positive whole number");
    }
    contextBudget = Number(rawBudget);
  }
  return { baseUrl, token, ownerId, contextBudget, endpointTrust };
}

export async function prepareMemmyConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: { allowPrivateEndpoint?: boolean; resolveHostname?: ResolveHostname },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  // Classified again here: DNS may have flipped public→private since the caller's owner check.
  const classified = await classifyMemmyConnectionSettings(settings, options?.resolveHostname);
  const connection = parseMemmyConnection(classified, credentials);
  if (connection.endpointTrust === "private") {
    // Loopback needs no DNS pin, so refuse non-owners here before anything resolves.
    if (options?.allowPrivateEndpoint !== true) {
      throw egressRefused(
        URL.parse(connection.baseUrl)?.hostname ?? "",
        new MemoryProviderPrivateEndpointRequiredError(),
      );
    }
    await pinLocalServiceHost(connection.baseUrl, {
      allowPrivateEndpoint: true,
      resolveHostname: options.resolveHostname,
    });
  }
  return {
    settings: {
      baseUrl: connection.baseUrl,
      ...(connection.endpointTrust === "private" ? { endpointTrust: "private" } : {}),
      ...(settings.ownerId?.trim() ? { ownerId: connection.ownerId } : {}),
      ...(settings.contextBudget?.trim()
        ? { contextBudget: String(connection.contextBudget) }
        : {}),
    },
    credentials: { token: connection.token },
  };
}

type ClientSeams = Pick<MemmyClientOptions, "fetch" | "resolveHostname" | "now">;

function clientFor(connection: MemmyConnection, seams: ClientSeams = {}): MemmyMemoryClient {
  return new MemmyMemoryClient({
    baseUrl: connection.baseUrl,
    token: connection.token,
    endpointTrust: connection.endpointTrust,
    ...seams,
  });
}

/**
 * Memmy has no Space, so a profile per bot or per Space carries the scope. The prefixes keep a
 * bot id and a Space id from ever naming the same profile.
 */
function writeProfile(scope: DurableMemoryScope, botId: string, spaceId: string): string {
  return scope === "shared" ? `space:${spaceId}` : `bot:${botId}`;
}

/**
 * Concurrent bots keep separate source ledgers while sharing the Space's memory profile.
 * The versioned tuple preserves component boundaries even when ids contain delimiters.
 * Memmy's sessionKey selects session identity, not retrieval filtering, so separate bot
 * conversations keep Space-wide memory recall shared.
 */
function sourceConversationId(scope: DurableMemoryScope, threadId: string, botId: string): string {
  return scope === "shared" ? `thread-bot:v1:${JSON.stringify([threadId, botId])}` : threadId;
}

/** Shared recall reads the Space first, then this bot's original isolated conversation. */
function recallNamespaces(
  ownerId: string,
  target: {
    scope: DurableMemoryScope;
    botId: string;
    spaceId: string;
    threadId?: string;
  },
): MemmyNamespace[] {
  const namespace = (scope: DurableMemoryScope): MemmyNamespace => ({
    source: MEMMY_SOURCE,
    userId: ownerId,
    profileId: writeProfile(scope, target.botId, target.spaceId),
    ...(target.threadId
      ? { sessionKey: sourceConversationId(scope, target.threadId, target.botId) }
      : {}),
  });
  return target.scope === "shared"
    ? [namespace("shared"), namespace("isolated")]
    : [namespace("isolated")];
}

/**
 * Scope changes the namespace sent to Memmy, not its security boundary. profileId does not
 * isolate ordinary memories inside one instance; private trust domains need independent
 * instances. sharedScope advertises the namespace mapping, not enforcement by this adapter.
 */
export class MemmyMemoryProvider implements SemanticMemoryProvider {
  constructor(
    private readonly connection: MemmyConnection,
    private readonly client: MemmyMemoryClient,
  ) {}

  describe() {
    return {
      id: MEMMY_PROVIDER_ID,
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
    const query = request.query.trim().slice(0, MAX_SEARCH_QUERY_CHARS);
    if (!query) return { ok: true, value: [] };
    const result = await this.client.search(
      {
        query,
        layers: MEMMY_RECALL_LAYERS,
        limit: request.limit,
        contextBudget: this.connection.contextBudget,
        namespaces: recallNamespaces(this.connection.ownerId, {
          scope: request.scope,
          botId: request.botId,
          spaceId: context.spaceId,
        }),
      },
      context.signal,
    );
    if (!result.ok) return { ok: false, error: `Memmy recall failed: ${result.error}` };
    return {
      ok: true,
      value: result.value.sections.map((section) => ({
        memory: section.content,
        score: 1,
        id: section.id,
      })),
    };
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    if (request.source.kind === "history") {
      // Compaction summaries stay in Rakazo, which is why purgeHistory has nothing to purge.
      // Per-turn capture already gives Memmy the turns those summaries condense.
      return { ok: true, value: undefined };
    }
    const content = request.content.trim();
    if (!content) return { ok: false, error: "Memmy save skipped: memory content is empty." };
    return this.client.add(
      {
        requestId: randomUUID(),
        content,
        layer: "L2",
        tags: [MEMMY_SOURCE, "durable"],
        namespace: {
          source: MEMMY_SOURCE,
          userId: this.connection.ownerId,
          profileId: writeProfile(request.scope, request.botId, context.spaceId),
        },
      },
      context.signal,
    );
  }

  async purgeHistory(
    _request: { botId: string; generations: number[] },
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // History generations are never written to Memmy.
    return { ok: true, value: undefined };
  }
}

export class MemmyTurnMemory implements TurnMemoryLifecycle {
  constructor(
    private readonly connection: MemmyConnection,
    private readonly client: MemmyMemoryClient,
  ) {}

  async beforeTurn(
    request: TurnMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<TurnMemoryRecall | null> {
    try {
      const query = request.query.trim().slice(0, MAX_SEARCH_QUERY_CHARS);
      if (!query) return null;
      const result = await this.client.search(
        {
          query,
          layers: MEMMY_RECALL_LAYERS,
          limit: MEMMY_TURN_RECALL_LIMIT,
          contextBudget: request.contextBudget ?? this.connection.contextBudget,
          namespaces: recallNamespaces(this.connection.ownerId, {
            scope: request.scope,
            botId: request.botId,
            spaceId: context.spaceId,
            threadId: request.threadId,
          }),
        },
        context.signal,
      );
      if (!result.ok) {
        getLogger().warn("memmy turn recall skipped", {
          reason: result.error,
          runId: request.runId,
        });
        return null;
      }
      if (result.value.sections.length === 0) return null;
      return { sections: result.value.sections, sourceMemoryIds: result.value.sourceMemoryIds };
    } catch (error) {
      // The turn must run without memory rather than fail.
      getLogger().warn("memmy turn recall failed", {
        reason: error instanceof Error ? error.name : "unknown",
        runId: request.runId,
      });
      return null;
    }
  }

  async captureTurn(
    capture: TurnMemoryCapture,
    context: AdapterContext,
  ): Promise<TurnMemoryCaptureResult> {
    try {
      return await this.client.complete(
        memmyCaptureBody(capture, {
          ownerId: this.connection.ownerId,
          spaceId: context.spaceId,
        }),
        context.signal,
      );
    } catch (error) {
      return {
        status: "retryable",
        reason: error instanceof Error ? `capture_error:${error.name}` : "capture_error",
      };
    }
  }
}

/**
 * The source-turns/complete body. Built only from the capture, so a retry of the same stored
 * turn sends the same content and Memmy answers "existing" instead of "conflict".
 */
export function memmyCaptureBody(
  capture: TurnMemoryCapture,
  target: { ownerId: string; spaceId: string },
  requestId: string = randomUUID(),
): MemmySourceTurnBody {
  return {
    requestId,
    channel: "hook",
    source: MEMMY_SOURCE,
    namespace: { userId: target.ownerId },
    sourceTurn: {
      source: MEMMY_SOURCE,
      profileId: writeProfile(capture.scope, capture.botId, target.spaceId),
      conversationId: sourceConversationId(capture.scope, capture.threadId, capture.botId),
      turnId: capture.runId,
      startedAt: capture.startedAt,
      completedAt: capture.completedAt,
      ...(capture.sequence !== undefined ? { sequence: capture.sequence } : {}),
      completionEvidence: MEMMY_COMPLETION_EVIDENCE,
    },
    query: capture.query,
    answer: capture.answer,
    status: "succeeded",
    toolCalls: capture.toolCalls.map((call) => ({ name: call.name, input: call.input })),
    toolResults: capture.toolResults.map((result) => ({
      name: result.name,
      output: result.output,
    })),
    sourceMemoryIds: [...capture.sourceMemoryIds],
  };
}

export function createMemmyProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  seams?: ClientSeams,
): SemanticMemoryProvider {
  const connection = parseMemmyConnection(settings, credentials);
  return new MemmyMemoryProvider(connection, clientFor(connection, seams));
}

export function createMemmyTurnMemory(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  seams?: ClientSeams,
): TurnMemoryLifecycle {
  const connection = parseMemmyConnection(settings, credentials);
  return new MemmyTurnMemory(connection, clientFor(connection, seams));
}
