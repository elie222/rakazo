import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import { isCloudMetadataHost, isLocalMcpHost } from "@rakazo/contracts";
import type { ResolvedAddress, ResolveHostname } from "./network-address.js";
import { isCloudMetadataAddress, isLinkLocalAddress, isPrivateAddress } from "./network-address.js";
import { isPrivateRemoteMcpHostname } from "./remote-mcp.js";
import { MemoryProviderDeploymentOwnerRequiredError } from "./serenity-memory-provider.js";
import type { SupermemoryConnectionConfig } from "./supermemory-client.js";
import {
  deleteSupermemoryContainer,
  parseSupermemoryBaseUrl,
  probeSupermemory,
  SUPERMEMORY_CLOUD_BASE_URL,
  saveSupermemoryMemoryToContainers,
  searchSupermemoryContainers,
} from "./supermemory-client.js";

export const SUPERMEMORY_PROVIDER_ID = "supermemory";
export { SUPERMEMORY_CLOUD_BASE_URL };

const LOCAL_NETWORK_ERROR = "Local mode requires a loopback or private-network address.";
const BLOCKED_TARGET_ERROR = "Local mode cannot target a blocked address.";

const defaultResolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export function supermemoryRequiresDeploymentOwner(settings: Record<string, string>): boolean {
  return settings.mode === "local";
}

function hostnameOf(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isBlockedSupermemoryHost(host: string): boolean {
  if (isCloudMetadataHost(host)) return true;
  return isIP(host) !== 0 && (isCloudMetadataAddress(host) || isLinkLocalAddress(host));
}

function assertPrivateLanAddresses(addresses: ResolvedAddress[]): void {
  if (
    addresses.some(
      (entry) => isCloudMetadataAddress(entry.address) || isLinkLocalAddress(entry.address),
    )
  ) {
    throw new Error(BLOCKED_TARGET_ERROR);
  }
  if (addresses.length === 0 || addresses.some((entry) => !isPrivateAddress(entry.address))) {
    throw new Error(LOCAL_NETWORK_ERROR);
  }
}

/** Literals and metadata names. Hostnames are classified by assertSupermemoryLocalBaseUrl. */
function assertSupermemoryLocalBaseUrlSync(baseUrl: string): void {
  const host = hostnameOf(parseSupermemoryBaseUrl(baseUrl));
  if (isBlockedSupermemoryHost(host)) throw new Error(BLOCKED_TARGET_ERROR);
  if (isLocalMcpHost(host) || isPrivateRemoteMcpHostname(host)) return;
  if (isIP(host) !== 0) throw new Error(LOCAL_NETWORK_ERROR);
}

/**
 * Local mode accepts loopback or a private-network host (Compose DNS, RFC1918, LAN suffixes).
 * Public hosts stay rejected. Private hosts require deployment-owner authorization.
 * Returns the pinned addresses for a hostname, or undefined when the host needs no DNS pin.
 */
async function pinSupermemoryPrivateHost(
  baseUrl: string,
  options: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
  } = {},
): Promise<ResolvedAddress[] | undefined> {
  assertSupermemoryLocalBaseUrlSync(baseUrl);
  const host = hostnameOf(parseSupermemoryBaseUrl(baseUrl));
  if (isLocalMcpHost(host)) return undefined;
  if (options.allowPrivateEndpoint !== true) {
    throw new MemoryProviderDeploymentOwnerRequiredError();
  }
  if (isIP(host) !== 0) return undefined;
  const resolve = options.resolveHostname ?? defaultResolveHostname;
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new Error(LOCAL_NETWORK_ERROR);
  }
  assertPrivateLanAddresses(addresses);
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
}

export async function assertSupermemoryLocalBaseUrl(
  baseUrl: string,
  options: {
    allowPrivateEndpoint?: boolean;
    resolveHostname?: ResolveHostname;
  } = {},
): Promise<void> {
  await pinSupermemoryPrivateHost(baseUrl, options);
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
  if (mode === "local") assertSupermemoryLocalBaseUrlSync(baseUrl);
  parseSupermemoryBaseUrl(baseUrl);
  return { mode, baseUrl, apiKey };
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
  const pinnedAddresses =
    mode === "local" ? await pinSupermemoryPrivateHost(baseUrl, options) : undefined;
  const probe = await probeSupermemory({
    baseUrl,
    apiKey,
    resolveHostname: options?.resolveHostname,
    fetch: options?.fetch,
    ...(pinnedAddresses ? { pinnedAddresses } : {}),
  });
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
  private pinnedAddresses?: ResolvedAddress[];
  private hostReady = false;
  private pinTask?: Promise<void>;

  constructor(private readonly connection: SupermemoryConnectionConfig) {}

  private async localBaseUrlBlock(): Promise<string | null> {
    if (isSupermemoryCloudBaseUrl(this.connection.baseUrl)) return null;
    // One successful check per provider. Repeating it would let a DNS blip block
    // a host this provider already reached, and multi-tag recall would redo it.
    if (this.hostReady) return null;
    this.pinTask ??= this.resolvePin();
    try {
      await this.pinTask;
      this.hostReady = true;
      return null;
    } catch (error) {
      this.pinTask = undefined;
      return error instanceof Error ? error.message : BLOCKED_TARGET_ERROR;
    }
  }

  private async resolvePin(): Promise<void> {
    const pinned = await pinSupermemoryPrivateHost(this.connection.baseUrl, {
      allowPrivateEndpoint: true,
      resolveHostname: this.connection.resolveHostname,
    });
    if (pinned) this.pinnedAddresses = pinned;
  }

  private connectionForRequest(): SupermemoryConnectionConfig {
    if (!this.pinnedAddresses) return this.connection;
    return { ...this.connection, pinnedAddresses: this.pinnedAddresses };
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
    const blocked = await this.localBaseUrlBlock();
    if (blocked) return { ok: false, error: blocked };
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
