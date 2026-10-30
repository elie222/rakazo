import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import type { HindsightConnectionConfig } from "./hindsight-client.js";
import {
  parseHindsightBank,
  probeHindsight,
  recallHindsight,
  retainHindsight,
} from "./hindsight-client.js";
import {
  assertLocalServiceBaseUrl,
  LocalServiceHost,
  parseServiceBaseUrl,
  pinLocalServiceHost,
} from "./local-service-endpoint.js";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";

export const HINDSIGHT_PROVIDER_ID = "hindsight";

/** Where a bot's durable facts are written, and which of them it reads back. */
export type HindsightReadScope = "bank" | "bot";

export interface HindsightSettings extends HindsightConnectionConfig {
  allowWrites: boolean;
  readScope: HindsightReadScope;
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

function parseReadScope(value: string | undefined): HindsightReadScope {
  if (value === undefined || value === "" || value === "bank") return "bank";
  if (value === "bot") return "bot";
  throw new Error('readScope must be "bank" or "bot"');
}

function parseHindsightSettings(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): HindsightSettings {
  const baseUrl = requiredValue(settings, "baseUrl");
  parseServiceBaseUrl(baseUrl);
  const token = credentials.token?.trim();
  return {
    baseUrl,
    bank: parseHindsightBank(settings.bank?.trim() || "life"),
    ...(token ? { token } : {}),
    allowWrites: parseBooleanSetting(settings.allowWrites, true),
    readScope: parseReadScope(settings.readScope),
  };
}

/** A self-hosted Hindsight is a private endpoint, so an owner must authorize it. */
export function hindsightRequiresPrivateEndpoint(settings: Record<string, string>): boolean {
  return Boolean(settings.baseUrl?.trim());
}

/** Recheck a persisted endpoint before its credentials are decrypted. */
export async function revalidateHindsightSettings(settings: Record<string, string>): Promise<void> {
  const baseUrl = settings.baseUrl?.trim();
  if (!baseUrl) throw new Error("baseUrl is required");
  await assertLocalServiceBaseUrl(baseUrl, { allowPrivateEndpoint: true });
}

export async function prepareHindsightConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  options?: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
    fetch?: typeof globalThis.fetch;
  },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const parsed = parseHindsightSettings(settings, credentials);
  const pinnedAddresses: ResolvedAddress[] | undefined = await pinLocalServiceHost(parsed.baseUrl, {
    allowPrivateEndpoint: options?.allowPrivateEndpoint,
    resolveHostname: options?.resolveHostname,
  });
  const connection: HindsightConnectionConfig = {
    baseUrl: parsed.baseUrl,
    bank: parsed.bank,
    ...(parsed.token ? { token: parsed.token } : {}),
    resolveHostname: options?.resolveHostname,
    ...(options?.fetch ? { fetch: options.fetch } : {}),
    ...(pinnedAddresses ? { pinnedAddresses } : {}),
  };
  const probe = await probeHindsight(connection);
  if (!probe.ok) throw new Error(probe.error);
  return {
    settings: {
      baseUrl: parsed.baseUrl,
      bank: parsed.bank,
      allowWrites: String(parsed.allowWrites),
      readScope: parsed.readScope,
    },
    // Always store a credentials record: an empty object cannot be decoded back later.
    credentials: { token: parsed.token ?? "" },
  };
}

export function createHindsightProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): SemanticMemoryProvider {
  return new HindsightMemoryProvider(parseHindsightSettings(settings, credentials));
}

/** Attribution tags. The bot reads the shared bank, so these are for auditing and purge. */
function botTags(scope: DurableMemoryScope, botId: string, spaceId: string): string[] {
  const bot = `rakazo:bot:${botId}`;
  return scope === "shared" ? [`rakazo:space:${spaceId}`, bot] : [bot];
}

function documentId(botId: string, spaceId: string): string {
  return `rakazo-${spaceId}-${botId}`;
}

export class HindsightMemoryProvider implements SemanticMemoryProvider {
  private readonly localHost: LocalServiceHost;

  constructor(private readonly connection: HindsightSettings) {
    this.localHost = new LocalServiceHost(connection.baseUrl, connection.resolveHostname);
  }

  describe() {
    return {
      id: HINDSIGHT_PROVIDER_ID,
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

  private connectionForRequest(): HindsightConnectionConfig {
    return this.localHost.withPin(this.connection);
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    // A blank query would return the whole bank in arbitrary order.
    if (!request.query.trim()) return { ok: true, value: [] };
    const blocked = await this.localHost.block();
    if (blocked) return { ok: false, error: blocked };
    // "bank" shares one memory with everything else on it, Hermes included; that is the
    // point of pointing Rakazo at the same bank. "bot" narrows a bot to its own writes.
    const tags = this.connection.readScope === "bot" ? [`rakazo:bot:${request.botId}`] : undefined;
    const result = await recallHindsight(this.connectionForRequest(), {
      query: request.query,
      ...(tags ? { tags } : {}),
      limit: request.limit,
      signal: context.signal,
    });
    if (!result.ok) return result;
    return {
      ok: true,
      value: result.value.map((item) => ({
        memory: item.memory,
        score: item.score,
        ...(item.id ? { id: item.id } : {}),
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
        provenance: `hindsight bank:${this.connection.bank}`,
      })),
    };
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // Compaction summaries stay in Rakazo; the shared bank holds durable facts only.
    if (request.source.kind === "history") return { ok: true, value: undefined };
    if (!this.connection.allowWrites) {
      return {
        ok: false,
        error:
          "Hindsight writes are turned off for this Space. Turn on writing in Memory settings to save durable facts.",
      };
    }
    const blocked = await this.localHost.block();
    if (blocked) return { ok: false, error: blocked };
    const result = await retainHindsight(this.connectionForRequest(), {
      content: request.content,
      tags: botTags(request.scope, request.botId, context.spaceId),
      documentId: documentId(request.botId, context.spaceId),
      metadata: {
        rakazoSpace: context.spaceId,
        rakazoBot: request.botId,
        rakazoScope: request.scope,
      },
      signal: context.signal,
    });
    return result.ok ? { ok: true, value: undefined } : result;
  }

  async purgeHistory(
    _request: { botId: string; generations: number[] },
    _context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    // Nothing is written for history generations, so there is nothing to purge. Hindsight
    // 0.10.2 exposes no delete route, so this provider also omits forget().
    return { ok: true, value: undefined };
  }
}
