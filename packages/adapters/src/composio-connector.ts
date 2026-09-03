import console from "node:console";
import { Composio } from "@composio/core";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import {
  composioToolkitDirectory,
  mergeCatalogWithConnected,
  type ToolkitDirectoryEntry,
} from "./composio-catalog-cache.js";
import { DestinationEmulator } from "./destination-emulator.js";

type ComposioSession = Awaited<ReturnType<Composio["create"]>>;

export function isComposioEnabled(apiKey: string | undefined): boolean {
  return Boolean(apiKey) && !process.env.VITEST;
}

export function asConnectorTools(input: unknown): ConnectorTool[] {
  const items = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { items?: unknown }).items)
      ? ((input as { items: unknown[] }).items ?? [])
      : [];
  const tools: ConnectorTool[] = [];
  for (const item of items) {
    const mapped = mapOneTool(item);
    if (mapped) tools.push(mapped);
  }
  return tools;
}

function mapOneTool(item: unknown): ConnectorTool | undefined {
  if (!item || typeof item !== "object") return undefined;
  const raw = item as Record<string, unknown>;
  if (raw.type === "function" && raw.function && typeof raw.function === "object") {
    const fn = raw.function as Record<string, unknown>;
    const name = String(fn.name ?? "");
    if (!name) return undefined;
    return {
      name,
      description: String(fn.description ?? name),
      inputSchema: asObject(fn.parameters) ?? { type: "object", properties: {} },
      route: { connectorId: "composio", toolName: name },
    };
  }
  const name = String(raw.slug ?? raw.name ?? "");
  if (!name) return undefined;
  return {
    name,
    description: String(raw.description ?? name),
    inputSchema: asObject(raw.inputParameters) ??
      asObject(raw.inputSchema) ??
      asObject(raw.parameters) ?? { type: "object", properties: {} },
    route: { connectorId: "composio", toolName: name },
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type ComposioCatalogItem = Omit<ConnectorCatalogItem, "connectorId">;

export interface ComposioProvider extends ManagedConnectorProvider {
  warmDirectory(): Promise<void>;
  listConnectedSlugs(userId: string): Promise<string[]>;
}

export function filterCatalog<T extends Pick<ComposioCatalogItem, "name" | "slug">>(
  items: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (item) => item.name.toLowerCase().includes(needle) || item.slug.toLowerCase().includes(needle),
  );
}

export async function collectPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; cursor?: string }>,
  maxPages = 200,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (!result.cursor) break;
    cursor = result.cursor;
  }
  return items;
}

function composioSlugKey(slug: string): string {
  return slug.trim().toLowerCase();
}

export function executeSessionKey(toolkits: string[]): string {
  const unique = new Map<string, string>();
  for (const slug of toolkits) {
    const trimmed = slug.trim();
    const key = composioSlugKey(trimmed);
    if (key && !unique.has(key)) unique.set(key, trimmed);
  }
  return [...unique.values()].sort().join(",");
}

export type PluginConnectionRow = {
  id: string;
  provider: string;
  status: string;
  displayName: string;
};

export function needsLivePluginSync(rows: { status: string }[]): boolean {
  return rows.some((row) => row.status === "pending" || row.status === "error");
}

export function mergeConnectedPlugins(
  rows: { provider: string; displayName: string; status?: string }[],
  liveSlugs: string[],
): { provider: string; displayName: string }[] {
  const live = new Set(liveSlugs.map((slug) => composioSlugKey(slug)).filter(Boolean));
  const byProvider = new Map<string, { provider: string; displayName: string }>();
  for (const row of rows) {
    if (!row.provider) continue;
    const include =
      row.status === "connected" ||
      row.status === undefined ||
      live.has(composioSlugKey(row.provider));
    if (!include) continue;
    const current = byProvider.get(composioSlugKey(row.provider));
    if (!current || composioSlugKey(current.displayName) === composioSlugKey(current.provider)) {
      byProvider.set(composioSlugKey(row.provider), {
        provider: row.provider,
        displayName: row.displayName,
      });
    }
  }
  return [...byProvider.values()];
}

export function planLiveConnectionSync(
  rows: PluginConnectionRow[],
  liveSlugs: string[],
): { connectIds: string[]; revokeIds: string[] } {
  const live = new Set(liveSlugs.map(composioSlugKey).filter(Boolean));
  const connectIds: string[] = [];
  const connectedProviders = new Set(
    rows.filter((row) => row.status === "connected").map((row) => composioSlugKey(row.provider)),
  );
  for (const slug of live) {
    if (connectedProviders.has(slug)) continue;
    const matches = rows.filter((row) => composioSlugKey(row.provider) === slug);
    const reusable =
      matches.find((row) => row.status === "pending" || row.status === "error") ??
      matches.find((row) => row.status === "revoked") ??
      matches[0];
    if (!reusable) continue;
    connectIds.push(reusable.id);
    connectedProviders.add(slug);
  }
  const connectIdSet = new Set(connectIds);
  const revokeIds = rows
    .filter(
      (row) => (row.status === "pending" || row.status === "error") && !connectIdSet.has(row.id),
    )
    .map((row) => row.id);
  return { connectIds, revokeIds };
}

export class ComposioConnector implements ComposioProvider {
  private client: Composio | undefined;
  private readonly catalogSessions = new Map<string, string>();
  private readonly executeSessions = new Map<string, { sessionId: string; key: string }>();

  describe() {
    return {
      id: "composio",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async sessionFor(userId: string): Promise<ComposioSession> {
    const composio = this.sdk();
    const existing = this.catalogSessions.get(userId);
    if (existing) {
      try {
        return await composio.sessions.use(existing);
      } catch {
        this.catalogSessions.delete(userId);
      }
    }
    const session = await composio.create(userId, {
      manageConnections: false,
      sandbox: { enable: false },
    });
    this.catalogSessions.set(userId, session.sessionId);
    return session;
  }

  async sessionForExecute(userId: string, toolkits: string[]): Promise<ComposioSession> {
    const canonicalToolkits = await this.canonicalizeToolkits(toolkits);
    const key = executeSessionKey(canonicalToolkits);
    if (!key) return this.sessionFor(userId);
    const composio = this.sdk();
    const existing = this.executeSessions.get(userId);
    if (existing?.key === key) {
      try {
        return await composio.sessions.use(existing.sessionId);
      } catch {
        this.executeSessions.delete(userId);
      }
    }
    const session = await composio.create(userId, {
      manageConnections: false,
      sandbox: { enable: false },
      toolkits: canonicalToolkits,
    });
    this.executeSessions.set(userId, { sessionId: session.sessionId, key });
    return session;
  }

  async catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]> {
    const [directory, connected] = await Promise.all([
      this.directory(),
      this.listConnectedSlugs(context.userId),
    ]);
    return filterCatalog(mergeCatalogWithConnected(directory, connected), query ?? "").map(
      (item) => ({ ...item, connectorId: "composio" }),
    );
  }

  async warmDirectory(): Promise<void> {
    await this.directory();
  }

  private async canonicalizeToolkits(toolkits: string[]): Promise<string[]> {
    const directory = await this.directory().catch(() => []);
    const canonical = new Map(directory.map((item) => [composioSlugKey(item.slug), item.slug]));
    const unique = new Map<string, string>();
    for (const toolkit of toolkits) {
      const trimmed = toolkit.trim();
      const key = composioSlugKey(trimmed);
      if (key && !unique.has(key)) {
        unique.set(key, canonical.get(key) ?? trimmed.toUpperCase());
      }
    }
    return [...unique.values()].sort();
  }

  private async directory(): Promise<ToolkitDirectoryEntry[]> {
    return composioToolkitDirectory.get(() => this.loadDirectory());
  }

  private async loadDirectory(): Promise<ToolkitDirectoryEntry[]> {
    const session = await this.sessionFor("__rakazo_catalog__");
    const toolkits = await collectPages((cursor) => session.toolkits({ limit: 50, cursor }));
    return toolkits.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.name,
      logo: toolkit.logo ?? null,
      noAuth: Boolean(toolkit.isNoAuth),
    }));
  }

  async listConnectedSlugs(userId: string): Promise<string[]> {
    const session = await this.sessionFor(userId);
    const connected = await collectPages((cursor) =>
      session.toolkits({ isConnected: true, limit: 50, cursor }),
    );
    return connected.map((toolkit) => toolkit.slug);
  }

  async listConnectedExternalIds(context: AdapterContext): Promise<string[]> {
    return this.listConnectedSlugs(context.userId);
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const toolkits = connectedComposioExternalIds(context);
    if (toolkits.length === 0) return [];
    const session = await this.sessionForExecute(context.userId, toolkits);
    const raw = await session.tools();
    return asConnectorTools(raw);
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    try {
      const session = await this.sessionForExecute(
        context.userId,
        connectedComposioExternalIds(context),
      );
      const result = await session.execute(call.tool, call.args ?? {});
      if (result.error) {
        yield { type: "error", message: sanitizeComposioError(result.error) };
        return;
      }
      const logId = collectLogIds(result)[0] ?? "";
      yield {
        type: "result",
        data: {
          data: sanitizePayload(result.data),
          logId,
        },
      };
    } catch (error) {
      yield { type: "error", message: sanitizeComposioError(error) };
    }
  }

  async begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }> {
    const session = await this.sessionFor(context.userId);
    try {
      const connectionRequest = await session.authorize(request.provider, {
        callbackUrl: request.redirectUrl,
      });
      if (!connectionRequest.redirectUrl) {
        await connectionRequest.waitForConnection(20_000).catch(() => undefined);
      }
      return {
        authorizationUrl: connectionRequest.redirectUrl ?? null,
        state: connectionRequest.id || request.provider,
      };
    } catch (error) {
      if (isNoAuthToolkitError(error)) {
        return { authorizationUrl: null, state: request.provider };
      }
      throw new Error(sanitizeComposioError(error));
    }
  }

  async connectionReady(context: AdapterContext, slug: string): Promise<boolean> {
    const session = await this.sessionFor(context.userId);
    const page = await session.toolkits({ search: slug, limit: 50 });
    const match = page.items.find((item) => composioSlugKey(item.slug) === composioSlugKey(slug));
    if (!match) return false;
    return Boolean(match.connection?.isActive) || Boolean(match.isNoAuth);
  }

  async complete(
    request: { state: string; code?: string },
    _context: AdapterContext,
  ): Promise<{ connectionRef: string }> {
    return { connectionRef: request.state };
  }

  async revoke(connectionRef: string, context: AdapterContext): Promise<void> {
    const accountId = await this.connectedAccountId(context.userId, connectionRef);
    if (accountId) await this.sdk().connectedAccounts.delete(accountId);
  }

  async connectedAccountId(userId: string, slug: string): Promise<string | undefined> {
    const session = await this.sessionFor(userId);
    const toolkits = await session.toolkits({ isConnected: true });
    return toolkits.items.find((item) => composioSlugKey(item.slug) === composioSlugKey(slug))
      ?.connection?.connectedAccount?.id;
  }

  private sdk(): Composio {
    this.client ??= new Composio();
    return this.client;
  }
}

export class ConnectorRegistry implements ConnectorProvider {
  private readonly providers = new Map<string, ConnectorProvider>();

  constructor(
    readonly destination: DestinationEmulator,
    providers: ConnectorProvider[],
  ) {
    this.providers.set("destination", destination);
    for (const provider of providers) {
      const id = provider.describe().id;
      if (this.providers.has(id)) throw new Error(`Duplicate connector id ${id}`);
      this.providers.set(id, provider);
    }
  }

  managedProviders(): ManagedConnectorProvider[] {
    return [...this.providers.values()].filter(isManagedConnectorProvider);
  }

  managed(id: string): ManagedConnectorProvider | undefined {
    const provider = this.providers.get(id);
    return provider && isManagedConnectorProvider(provider) ? provider : undefined;
  }

  describe() {
    return {
      id: "connector-registry",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const discovered: ConnectorTool[] = [];
    const used = new Set<string>();
    const providerTools = await Promise.all(
      [...this.providers].map(async ([connectorId, provider]) => {
        try {
          return [connectorId, await provider.discoverTools(context)] as const;
        } catch (error) {
          console.error("connector discovery failed", connectorId, sanitizeComposioError(error));
          return [connectorId, []] as const;
        }
      }),
    );
    for (const [connectorId, tools] of providerTools) {
      for (const tool of tools) {
        let name = tool.name;
        if (used.has(name)) name = `${connectorId}.${name}`;
        let suffix = 2;
        while (used.has(name)) {
          name = `${connectorId}.${tool.name}.${suffix}`;
          suffix += 1;
        }
        used.add(name);
        discovered.push({
          ...tool,
          name,
          route: tool.route ?? { connectorId, toolName: tool.name },
        });
      }
    }
    return discovered;
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const connectorId =
      call.route?.connectorId ?? (call.tool === "destination.write" ? "destination" : "composio");
    const provider = this.providers.get(connectorId);
    if (!provider) {
      yield { type: "error", message: `unknown connector ${connectorId}` };
      return;
    }
    yield* provider.execute({ ...call, tool: call.route?.toolName ?? call.tool }, context);
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    const connectorId = call.route?.connectorId;
    if (!connectorId) return undefined;
    const provider = this.providers.get(connectorId);
    return provider?.resolveCall?.({ ...call, tool: call.route?.toolName ?? call.tool }, context);
  }
}

/** @deprecated Use ConnectorRegistry. */
export const CompositeConnector = ConnectorRegistry;

function isManagedConnectorProvider(
  provider: ConnectorProvider,
): provider is ManagedConnectorProvider {
  const candidate = provider as Partial<ManagedConnectorProvider>;
  return (
    typeof candidate.catalog === "function" &&
    typeof candidate.begin === "function" &&
    typeof candidate.complete === "function" &&
    typeof candidate.connectionReady === "function" &&
    typeof candidate.listConnectedExternalIds === "function" &&
    typeof candidate.revoke === "function"
  );
}

function connectedComposioExternalIds(context: AdapterContext): string[] {
  return (
    context.connectedConnections
      ?.filter((connection) => connection.connectorId === "composio")
      .map((connection) => connection.externalId) ??
    context.connectedProviders ??
    []
  );
}

export function createConnectorStack(
  composioEnabled: boolean,
  composioOverride?: ComposioProvider,
  additionalProviders: ConnectorProvider[] = [],
) {
  const destination = new DestinationEmulator();
  const composio = composioOverride ?? (composioEnabled ? new ComposioConnector() : undefined);
  return {
    destination,
    composio,
    connector: new ConnectorRegistry(destination, [
      ...(composio ? [composio] : []),
      ...additionalProviders,
    ]),
  };
}

export function collectLogIds(value: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      if (
        (key === "logId" || key === "log_id") &&
        typeof nested === "string" &&
        nested &&
        !seen.has(nested)
      ) {
        seen.add(nested);
        ids.push(nested);
      } else {
        walk(nested);
      }
    }
  };
  walk(value);
  return ids;
}

export function isNoAuthToolkitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("ToolkitsIsNoAuth") || message.includes("does not require authentication")
  );
}

export function sanitizeComposioError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactConnectorText(message);
}

function sanitizePayload(data: unknown): unknown {
  try {
    return JSON.parse(redactConnectorText(JSON.stringify(data)));
  } catch {
    return { ok: true };
  }
}

function redactConnectorText(value: string): string {
  return value
    .replace(/COMPOSIO_API_KEY[=:]?\s*\S+/gi, "COMPOSIO_API_KEY=[redacted]")
    .replace(/ak_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/ck_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/sk-or-v1-[A-Za-z0-9]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
