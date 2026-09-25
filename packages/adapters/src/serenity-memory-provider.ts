import { createHash } from "node:crypto";
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
import {
  classifySerenityEndpointTrust,
  forgetSerenity,
  normalizeSerenityEndpoint,
  parseSerenityEndpoint,
  probeSerenity,
  recallSerenity,
  rememberSerenity,
  type SerenityConnectionConfig,
  type SerenityNetworkDependencies,
  serenityEndpointRequiresDeploymentOwner,
} from "./serenity-client.js";

export const SERENITY_PROVIDER_ID = "serenity";

/** Thrown when prepare would probe a private endpoint without deployment-owner authorization. */
export class MemoryProviderDeploymentOwnerRequiredError extends Error {
  readonly code = "DEPLOYMENT_OWNER_REQUIRED" as const;
  constructor(message = "This memory provider endpoint requires deployment-owner authorization.") {
    super(message);
    this.name = "MemoryProviderDeploymentOwnerRequiredError";
  }
}

function requiredValue(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parseBooleanSetting(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`expected boolean setting, got "${value}"`);
}

function parseSerenityConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SerenityConnectionConfig & {
  brainLabel: string;
  allowWrites: boolean;
} {
  const endpoint = normalizeSerenityEndpoint(requiredValue(settings, "endpoint"));
  parseSerenityEndpoint(endpoint);
  const token = requiredValue(credentials, "token");
  if (token.length < 8) throw new Error("token must contain at least 8 characters");
  const endpointTrust = settings.endpointTrust === "private" ? "private" : "public";
  return {
    endpoint,
    token,
    endpointTrust,
    brainLabel: settings.brainLabel?.trim() ?? "",
    allowWrites: parseBooleanSetting(settings.allowWrites, false),
  };
}

export function serenityRequiresDeploymentOwner(settings: Record<string, string>): boolean {
  if (settings.endpointTrust === "private") return true;
  const endpoint = settings.endpoint?.trim();
  if (!endpoint) return false;
  try {
    return serenityEndpointRequiresDeploymentOwner(normalizeSerenityEndpoint(endpoint));
  } catch {
    return false;
  }
}

/**
 * DNS/trust classification without probing. Callers must enforce deployment-owner
 * authorization on the result before any credentialed Serenity request.
 */
export async function classifySerenityConnectionSettings(
  settings: Record<string, string>,
  network?: SerenityNetworkDependencies,
): Promise<Record<string, string>> {
  const endpoint = normalizeSerenityEndpoint(requiredValue(settings, "endpoint"));
  parseSerenityEndpoint(endpoint);
  const endpointTrust = await classifySerenityEndpointTrust(endpoint, network?.resolveHostname);
  const classified: Record<string, string> = { ...settings, endpoint };
  if (endpointTrust === "private") classified.endpointTrust = "private";
  else delete classified.endpointTrust;
  return classified;
}

export async function prepareSerenityConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  network?: SerenityNetworkDependencies,
  options?: { allowPrivateEndpoint?: boolean },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const classifiedSettings = await classifySerenityConnectionSettings(settings, network);
  // Reclassification can flip public→private between the API owner check and this probe.
  // Non-owners must fail closed here before any credentialed MCP request.
  if (classifiedSettings.endpointTrust === "private" && options?.allowPrivateEndpoint === false) {
    throw new MemoryProviderDeploymentOwnerRequiredError();
  }
  const connection = parseSerenityConnection(classifiedSettings, credentials);
  const probe = await probeSerenity(
    {
      endpoint: connection.endpoint,
      token: connection.token,
      endpointTrust: connection.endpointTrust,
    },
    undefined,
    network,
    { requireWrites: connection.allowWrites },
  );
  if (!probe.ok) throw new Error(probe.error);
  return {
    settings: {
      endpoint: connection.endpoint,
      allowWrites: connection.allowWrites ? "true" : "false",
      ...(connection.endpointTrust === "private" ? { endpointTrust: "private" } : {}),
      ...(connection.brainLabel ? { brainLabel: connection.brainLabel } : {}),
    },
    credentials: { token: connection.token },
  };
}

export function createSerenityProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  const connection = parseSerenityConnection(settings, credentials);
  return new SerenityMemoryProvider(connection);
}

/**
 * Bot-scoped entity slug kept inside the adapter (Serenity has no container tags).
 * Appends a short digest of the case-folded original so labels that sanitize
 * identically (e.g. "prod brain" vs "prod-brain") stay in separate namespaces.
 */
export function sanitizeSerenityBrainLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  const slug = lower.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return "";
  const digest = createHash("sha256").update(lower).digest("hex").slice(0, 8);
  return `${slug.slice(0, 55)}-${digest}`;
}

// Serenity entity refs are exactly `type/slug`, so a label joins the slug rather than
// adding a path segment.
export function serenityBotEntity(botId: string, brainLabel = ""): string {
  const label = sanitizeSerenityBrainLabel(brainLabel);
  return label ? `rakazo-bot/${label}--${botId}` : `rakazo-bot/${botId}`;
}

export function serenitySpaceEntity(spaceId: string, brainLabel = ""): string {
  const label = sanitizeSerenityBrainLabel(brainLabel);
  return label ? `rakazo-space/${label}--${spaceId}` : `rakazo-space/${spaceId}`;
}

function recallEntities(
  scope: DurableMemoryScope,
  botId: string,
  spaceId: string,
  brainLabel: string,
): string[] {
  const bot = serenityBotEntity(botId, brainLabel);
  return scope === "shared" ? [serenitySpaceEntity(spaceId, brainLabel), bot] : [bot];
}

// Shared facts are written once to the Space so each save costs one hosted write.
function saveEntity(
  scope: DurableMemoryScope,
  botId: string,
  spaceId: string,
  brainLabel: string,
): string {
  return scope === "shared"
    ? serenitySpaceEntity(spaceId, brainLabel)
    : serenityBotEntity(botId, brainLabel);
}

/** Same run + entity + fact replays on retry instead of writing a duplicate fact. */
function rememberOperationKey(runScope: string, entity: string, fact: string): string {
  const digest = createHash("sha256")
    .update(`${runScope}\n${entity}\n${fact.trim()}`)
    .digest("hex")
    .slice(0, 48);
  return `rakazo:${digest}`;
}

export class SerenityMemoryProvider implements SemanticMemoryProvider {
  constructor(
    private readonly connection: SerenityConnectionConfig & {
      brainLabel: string;
      allowWrites: boolean;
    },
  ) {}

  describe() {
    return {
      id: SERENITY_PROVIDER_ID,
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
    // History compaction stays in Rakazo; Serenity is the durable brain only.
    const entities = recallEntities(
      request.scope,
      request.botId,
      context.spaceId,
      this.connection.brainLabel,
    );
    const results = await Promise.all(
      entities.map(async (entity) => ({
        entity,
        result: await recallSerenity(request.query, this.connection, {
          limit: request.limit,
          entity,
          signal: context.signal,
        }),
      })),
    );
    const errors = results.filter((entry) => !entry.result.ok);
    if (errors.length === results.length) {
      return {
        ok: false,
        error: errors.map((entry) => (entry.result.ok ? "" : entry.result.error)).join("; "),
      };
    }
    const seen = new Set<string>();
    const merged: SemanticMemoryResult[] = [];
    for (const { entity, result } of results) {
      if (!result.ok) continue;
      for (const fact of result.value) {
        if (seen.has(fact.factId)) continue;
        seen.add(fact.factId);
        merged.push({
          memory: fact.fact,
          score: 1,
          id: fact.factId,
          provenance: fact.provenance,
          entity,
        });
      }
    }
    return { ok: true, value: merged.slice(0, request.limit) };
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    if (request.source.kind === "history") {
      // Conversation summaries stay out of the user-owned Serenity brain.
      return { ok: true, value: undefined };
    }
    if (!this.connection.allowWrites) {
      return {
        ok: false,
        error:
          "Serenity writes are disabled for this Space. Enable writing in Memory settings to save durable facts.",
      };
    }
    const entity = saveEntity(
      request.scope,
      request.botId,
      context.spaceId,
      this.connection.brainLabel,
    );
    const provenance = `rakazo space:${context.spaceId} bot:${request.botId}`;
    const result = await rememberSerenity(request.content, provenance, this.connection, {
      entity,
      operationKey: rememberOperationKey(
        context.runId ?? context.operationId,
        entity,
        request.content,
      ),
      signal: context.signal,
    });
    return result.ok ? { ok: true, value: undefined } : { ok: false, error: result.error };
  }

  async purgeHistory(
    _request: { botId: string; generations: number[] },
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // History generations are never written to Serenity.
    return { ok: true, value: undefined };
  }

  async forget(
    request: SemanticMemoryForgetRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ id: string; expired: boolean; reason: string | null }>> {
    if (!this.connection.allowWrites) {
      return {
        ok: false,
        error:
          "Serenity writes are disabled for this Space. Enable writing in Memory settings to forget facts.",
      };
    }
    // Serenity forget is id-scoped (opaque fact_id); entity namespaces do not apply.
    const result = await forgetSerenity(request.id, this.connection, {
      reason: request.reason,
      signal: context.signal,
    });
    return result.ok ? { ok: true, value: result.value } : result;
  }
}
