import type {
  AdapterContext,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import type { HonchoConnectionConfig, HonchoReasoningLevel } from "./honcho-client.js";
import {
  createHonchoConclusions,
  ensureHonchoPeers,
  ensureHonchoWorkspace,
  HONCHO_CLOUD_BASE_URL,
  HONCHO_REASONING_LEVELS,
  honchoPeerChat,
  honchoResourceId,
  MAX_HONCHO_CONCLUSION_CHARS,
  probeHonchoAdminKey,
} from "./honcho-client.js";

export const HONCHO_PROVIDER_ID = "honcho";

// Shared peers are workspace-scoped; only an explicit workspace opts Spaces into sharing.
const SHARED_PEER_ID = honchoResourceId("rakazo-shared");

const DEFAULT_REASONING_LEVEL: HonchoReasoningLevel = "low";

/** Sentinel the dialectic is asked to return when it has nothing relevant. */
const NO_MEMORY = "NO_RELEVANT_MEMORY";

export function honchoRequiresDeploymentOwner(): boolean {
  // Cloud only: the endpoint is fixed and public.
  return false;
}

/** Spaces do not share memory implicitly, so each Space gets its own Honcho workspace by default. */
export function honchoWorkspaceId(settings: Record<string, string>, spaceId: string): string {
  const configured = settings.workspaceId?.trim();
  return honchoResourceId(configured || `rakazo-${spaceId}`);
}

export function honchoBotPeerId(botId: string): string {
  return honchoResourceId(`bot-${botId}`);
}

function parseHonchoConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): { connection: HonchoConnectionConfig; workspaceId: string } {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey || apiKey.length < 8 || apiKey.length > 4096) {
    throw new Error("apiKey must contain 8–4096 characters");
  }
  const reasoningLevel = (settings.reasoningLevel?.trim() ||
    DEFAULT_REASONING_LEVEL) as HonchoReasoningLevel;
  if (!HONCHO_REASONING_LEVELS.includes(reasoningLevel)) {
    throw new Error(`reasoningLevel must be one of ${HONCHO_REASONING_LEVELS.join(", ")}`);
  }
  const workspaceId = settings.workspaceId?.trim() ?? "";
  if (workspaceId && !/^[A-Za-z0-9_-]{1,512}$/.test(workspaceId)) {
    throw new Error("workspaceId may contain only letters, digits, '_' and '-'");
  }
  return {
    connection: { baseUrl: HONCHO_CLOUD_BASE_URL, apiKey, reasoningLevel },
    workspaceId,
  };
}

export async function prepareHonchoConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: { fetch?: typeof globalThis.fetch },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const { connection, workspaceId } = parseHonchoConnection(settings, credentials);
  const probeConnection = { ...connection, fetch: options?.fetch };
  // An explicit workspace must accept this key. Without one, each Space creates its own
  // workspace on first use, which only an admin key may do; listing checks that without writing.
  const probe = workspaceId
    ? await ensureHonchoWorkspace(probeConnection, workspaceId)
    : await probeHonchoAdminKey(probeConnection);
  if (!probe.ok) {
    throw new Error(
      workspaceId
        ? probe.error
        : `${probe.error}. A key scoped to one workspace needs that workspace entered.`,
    );
  }
  return {
    settings: {
      reasoningLevel: connection.reasoningLevel,
      ...(workspaceId ? { workspaceId } : {}),
    },
    credentials: { apiKey: connection.apiKey },
  };
}

export function createHonchoProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  const { connection } = parseHonchoConnection(settings, credentials);
  return new HonchoMemoryProvider(connection, settings);
}

function recallQuery(query: string): string {
  return [
    "Recall what you know about this Space that is relevant to the request below.",
    "Answer with the relevant facts only, as short plain statements.",
    `If you know nothing relevant, answer exactly ${NO_MEMORY}.`,
    "",
    `Request: ${query}`,
  ].join("\n");
}

export class HonchoMemoryProvider implements SemanticMemoryProvider {
  private readonly ensured = new Map<string, Promise<boolean>>();

  constructor(
    private readonly connection: HonchoConnectionConfig,
    private readonly settings: Record<string, string>,
  ) {}

  describe() {
    return {
      id: HONCHO_PROVIDER_ID,
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

  /** Peers are get-or-create; remember success per provider so each run pays for it once. */
  private async ensurePeers(
    workspaceId: string,
    peerIds: string[],
    signal: AbortSignal,
  ): Promise<SemanticMemoryResponse> {
    const key = [workspaceId, ...peerIds].join("\n");
    let pending = this.ensured.get(key);
    let error = "";
    if (!pending) {
      pending = ensureHonchoPeers(this.connection, workspaceId, peerIds, signal).then((result) => {
        if (!result.ok) error = result.error;
        return result.ok;
      });
      this.ensured.set(key, pending);
    }
    if (await pending) return { ok: true, value: undefined };
    this.ensured.delete(key);
    return { ok: false, error: error || "Honcho peers could not be created." };
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    const workspaceId = honchoWorkspaceId(this.settings, context.spaceId);
    const bot = honchoBotPeerId(request.botId);
    const ready = await this.ensurePeers(workspaceId, [SHARED_PEER_ID, bot], context.signal);
    if (!ready.ok) return ready;
    // Isolated: this bot's private view of the shared peer, independent of the user.
    // Shared: also the workspace-wide representation that all opted-in Spaces write to.
    const perspectives =
      request.scope === "shared"
        ? [
            { peerId: SHARED_PEER_ID, entity: SHARED_PEER_ID },
            { peerId: bot, target: SHARED_PEER_ID, entity: bot },
          ]
        : [{ peerId: bot, target: SHARED_PEER_ID, entity: bot }];
    const query = recallQuery(request.query);
    const answers = await Promise.all(
      perspectives.map(async ({ entity, ...perspective }) => ({
        entity,
        result: await honchoPeerChat(
          this.connection,
          workspaceId,
          { ...perspective, query },
          context.signal,
        ),
      })),
    );
    const failures = answers.filter((answer) => !answer.result.ok);
    if (failures.length === answers.length) {
      return {
        ok: false,
        error: failures.map((answer) => (answer.result.ok ? "" : answer.result.error)).join("; "),
      };
    }
    const results: SemanticMemoryResult[] = [];
    const seen = new Set<string>();
    for (const { entity, result } of answers) {
      if (!result.ok || !result.value || result.value.includes(NO_MEMORY)) continue;
      const normalized = result.value.replace(/\s+/g, " ").trim().toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      results.push({ memory: result.value, score: 1, provenance: "honcho", entity });
    }
    return { ok: true, value: results.slice(0, request.limit) };
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    if (request.source.kind === "history") {
      // Compaction summaries stay in Rakazo; Honcho holds durable facts only.
      return { ok: true, value: undefined };
    }
    const content = request.content.trim().slice(0, MAX_HONCHO_CONCLUSION_CHARS);
    if (!content) return { ok: false, error: "Honcho save skipped: memory content is empty." };
    const workspaceId = honchoWorkspaceId(this.settings, context.spaceId);
    const bot = honchoBotPeerId(request.botId);
    const ready = await this.ensurePeers(workspaceId, [SHARED_PEER_ID, bot], context.signal);
    if (!ready.ok) return ready;
    const conclusions = [{ content, observerId: bot, observedId: SHARED_PEER_ID }];
    if (request.scope === "shared")
      conclusions.push({ content, observerId: SHARED_PEER_ID, observedId: SHARED_PEER_ID });
    return createHonchoConclusions(this.connection, workspaceId, conclusions, context.signal);
  }

  async purgeHistory(
    _request: { botId: string; generations: number[] },
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // History generations are never written to Honcho.
    return { ok: true, value: undefined };
  }
}
