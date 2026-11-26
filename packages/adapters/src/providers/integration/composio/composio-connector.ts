import type {
  Composio,
  ConnectedAccountStatus,
  ToolRouterCreateSessionConfig,
} from "@composio/core";
import type {
  AdapterContext,
  ConnectedConnector,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { ConnectorAuthUnavailableError } from "@rakazo/adapter-kit";
import { isVitestRuntime } from "@rakazo/core/node/test-runtime";
import { getLogger } from "@rakazo/logging";
import { collectPages, filterCatalog } from "../../../integrations/connector-catalog.js";
import { isLazyCatalogControlRoute } from "../../../tools/lazy-tool-catalog.js";
import { connectedCalendarProvider } from "./calendar.js";
import { composioAccountIdentity } from "./composio-account-identity.js";
import { composioAccountTools, composioOwner, scopedAccounts } from "./composio-account-tools.js";
import { COMPOSIO_MULTI_EXECUTE_TOOL } from "./composio-batch.js";
import type { ToolkitDirectoryEntry } from "./composio-catalog-cache.js";
import {
  composioToolkitDirectory,
  createToolkitDirectoryCache,
  mergeCatalogWithConnected,
} from "./composio-catalog-cache.js";
import { composioSlugKey } from "./composio-connection-state.js";
import {
  collectLogIds,
  composioResultError,
  isComposioOutage,
  isNoAuthToolkitError,
  isNoManagedAuthError,
  isStaleConnectedAccountError,
  sanitizeIntegrationError,
  sanitizePayload,
  staleAccountIds,
  withSharedAccessHint,
} from "./composio-errors.js";
import { asConnectorTools } from "./composio-tool-mapping.js";

export type { PluginConnectionRow } from "./composio-connection-state.js";
export {
  AUTHORIZATION_WINDOW_MS,
  mergeConnectedPlugins,
  needsLivePluginSync,
  personalComposioConnections,
  pickReusableConnection,
  planLiveConnectionSync,
} from "./composio-connection-state.js";
export {
  collectLogIds,
  composioResultError,
  isNoAuthToolkitError,
  isNoManagedAuthError,
  sanitizeIntegrationError,
  withSharedAccessHint,
} from "./composio-errors.js";
export { asConnectorTools } from "./composio-tool-mapping.js";

type SdkSession = Awaited<ReturnType<Composio["create"]>>;

export type ComposioSession = Pick<
  SdkSession,
  "sessionId" | "toolkits" | "tools" | "execute" | "authorize"
>;

/** The Composio SDK surface the connector uses; offline tests inject a stateful fake. */
export type ComposioClient = {
  create(userId: string, config: ToolRouterCreateSessionConfig): Promise<ComposioSession>;
  tools?: Pick<Composio["tools"], "proxyExecute">;
  sessions: { use(sessionId: string): Promise<ComposioSession> };
  connectedAccounts: Pick<Composio["connectedAccounts"], "list" | "waitForConnection" | "delete">;
  toolkits: {
    get(query: {
      limit?: number;
    }): Promise<Array<{ slug: string; noAuth?: boolean; composioManagedAuthSchemes?: string[] }>>;
  };
  getClient(): {
    tools: {
      list(
        query: { toolkit_slug: string; limit: number; cursor?: string },
        options?: { signal?: AbortSignal },
      ): Promise<{
        items: unknown[];
        next_cursor?: string | null;
      }>;
    };
  };
  authConfigs: {
    list(query: { limit?: number; cursor?: string }): Promise<{
      items: Array<{ toolkit: { slug: string }; status: string }>;
      nextCursor: string | null;
    }>;
  };
};

/** Account states the user can only leave by reconnecting. */
const RECONNECT_STATUSES: ConnectedAccountStatus[] = ["EXPIRED", "INACTIVE", "FAILED", "REVOKED"];

export function isComposioEnabled(apiKey: string | undefined): boolean {
  return Boolean(apiKey) && !isVitestRuntime();
}

export interface ComposioProvider extends ManagedConnectorProvider {
  warmDirectory(): Promise<void>;
  listConnectedSlugs(userId: string): Promise<string[]>;
}

type ToolkitConnection = Awaited<ReturnType<ComposioSession["toolkits"]>>["items"][number];

function activeSlugs(toolkits: ToolkitConnection[]): string[] {
  return toolkits
    .filter((toolkit) => toolkit.connection?.isActive || toolkit.isNoAuth)
    .map((toolkit) => toolkit.slug);
}

/** Names the directory gets wrong: this toolkit only signs in to a business account. */
const TOOLKIT_NAMES = new Map([["whatsapp", "WhatsApp Business"]]);

export function toolkitDisplayName(toolkit: { slug: string; name: string }): string {
  return TOOLKIT_NAMES.get(composioSlugKey(toolkit.slug)) ?? toolkit.name;
}

export function executeSessionKey(
  toolkits: string[],
  connectedAccounts: Record<string, string[]> = {},
): string {
  const unique = new Map<string, string>();
  for (const slug of toolkits) {
    const trimmed = slug.trim();
    const key = composioSlugKey(trimmed);
    if (key && !unique.has(key)) unique.set(key, trimmed);
  }
  const toolkitKey = [...unique.values()].sort().join(",");
  const accountKey = Object.entries(connectedAccounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([toolkit, ids]) => `${toolkit}:${[...new Set(ids)].sort().join(",")}`)
    .join(";");
  return accountKey ? `${toolkitKey}|${accountKey}` : toolkitKey;
}

/** Connected-account listings are per user and toolkit; this bounds a runaway cursor. */
const MAX_ACCOUNT_PAGES = 20;
/** Folder listings treat a missing path as the account root. */
const DROPBOX_FOLDER_LIST_TOOLS = new Set(["DROPBOX_LIST_FILES_IN_FOLDER", "DROPBOX_LIST_FOLDERS"]);

export type ComposioExecutionCall = {
  tool: string;
  args: Record<string, unknown>;
  account?: string;
};

/**
 * `COMPOSIO_MULTI_EXECUTE_TOOL` nests each tool under `tools[]`. Dropbox folder
 * listing reads `arguments.path` and otherwise returns the account root, so a
 * path passed beside `arguments` or as a JSON string never selects the folder.
 * Those listing tools run directly with the folder path on the listing call.
 */
export function expandComposioMultiExecute(
  tool: string,
  args: Record<string, unknown>,
): ComposioExecutionCall[] {
  if (tool !== COMPOSIO_MULTI_EXECUTE_TOOL || !Array.isArray(args.tools)) {
    return [{ tool, args }];
  }
  const calls: ComposioExecutionCall[] = [];
  let pending: unknown[] = [];
  const flushPending = () => {
    if (pending.length === 0) return;
    calls.push({ tool, args: { ...args, tools: pending } });
    pending = [];
  };
  for (const item of args.tools) {
    const listing = dropboxFolderListCall(item);
    if (listing) {
      flushPending();
      calls.push(listing);
    } else {
      pending.push(item);
    }
  }
  flushPending();
  if (calls.length === 0 || (calls.length === 1 && calls[0]?.tool === tool)) {
    return [{ tool, args }];
  }
  return calls;
}

/** Composio tool slugs are prefixed with their toolkit slug, including multi-execute items. */
function callUsesToolkit(call: ConnectorCall, toolkit: string, toolkits: string[]): boolean {
  const prefix = `${composioSlugKey(toolkit)}_`;
  const tools = Array.isArray(call.args?.tools) ? call.args.tools : [];
  const slugs = [
    call.tool,
    ...tools.map((item) =>
      item && typeof item === "object" ? (item as { tool_slug?: unknown }).tool_slug : undefined,
    ),
  ];
  return slugs.some((slug) => {
    if (typeof slug !== "string") return false;
    const key = composioSlugKey(slug);
    if (!key.startsWith(prefix)) return false;
    // A longer connected toolkit owns its tools (e.g. GITHUB_MCP, not GITHUB).
    return !toolkits.some((candidate) => {
      const candidatePrefix = `${composioSlugKey(candidate)}_`;
      return candidatePrefix.length > prefix.length && key.startsWith(candidatePrefix);
    });
  });
}

function accountIsPinned(
  connectedAccounts: Record<string, string[]>,
  tool: string,
  account: string,
): boolean {
  const toolKey = composioSlugKey(tool);
  return Object.entries(connectedAccounts).some(
    ([toolkit, ids]) => toolKey.startsWith(`${composioSlugKey(toolkit)}_`) && ids.includes(account),
  );
}

function dropboxFolderListCall(item: unknown): ComposioExecutionCall | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;
  const slug = typeof record.tool_slug === "string" ? record.tool_slug.trim() : "";
  if (!slug || !DROPBOX_FOLDER_LIST_TOOLS.has(slug.toUpperCase())) return undefined;
  const toolArgs = objectArguments(record.arguments);
  if (!toolArgs) {
    throw new Error("Dropbox folder listing arguments must be a JSON object.");
  }
  const path = nonEmptyPath(record.path);
  if (path && !nonEmptyPath(toolArgs.path)) toolArgs.path = path;
  const account = typeof record.account === "string" ? record.account.trim() : "";
  return account ? { tool: slug, args: toolArgs, account } : { tool: slug, args: toolArgs };
}

function objectArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function nonEmptyPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class ComposioConnector implements ComposioProvider {
  private client: ComposioClient | undefined;
  private readonly apiKey: string | undefined;
  /** Only the keyless default connector shares the process-wide directory cache. */
  private readonly directoryCache: typeof composioToolkitDirectory;

  constructor(options: { apiKey?: string; client?: ComposioClient } = {}) {
    this.apiKey = options.apiKey;
    this.client = options.client;
    // The directory records which apps this project can sign in to, so each key needs its own.
    this.directoryCache =
      options.client || options.apiKey ? createToolkitDirectoryCache() : composioToolkitDirectory;
  }
  readonly calendarProvider = connectedCalendarProvider(async (connection, accountId, context) => {
    const active = await this.accountIds(
      composioOwner({ ...context, organizationId: connection.organizationId }),
      [connection.externalId],
      ["ACTIVE"],
      {
        signal: context.signal,
      },
    );
    return active.includes(accountId) ? (await this.sdk()).tools : undefined;
  });
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
    const composio = await this.sdk();
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

  /**
   * A toolkit whose every pinned account is no longer ACTIVE is left out of the
   * session: without a pin Composio would act as the user's newest active
   * account for that toolkit, which may be a different mailbox or workspace.
   */
  private async sessionForExecute(
    userId: string,
    connections: ConnectedConnector[],
  ): Promise<{
    session?: ComposioSession;
    reconnect: string[];
    connectedAccounts: Record<string, string[]>;
  }> {
    const requested = await this.canonicalizeToolkits(
      connections.map((connection) => connection.externalId),
    );
    const canonicalByKey = new Map(requested.map((toolkit) => [composioSlugKey(toolkit), toolkit]));
    const liveAccountIds = await this.listActiveAccountIds(userId, requested);
    const pinnedToolkits = new Set<string>();
    const accountIdsByToolkit = new Map<string, Set<string>>();
    for (const connection of connections) {
      const accountId = connection.providerRef?.trim();
      if (!accountId) continue;
      // No-auth and legacy rows store the toolkit slug rather than a remote
      // connected-account id. Only concrete account ids can scope a session.
      if (composioSlugKey(accountId) === composioSlugKey(connection.externalId)) continue;
      const toolkit = canonicalByKey.get(composioSlugKey(connection.externalId));
      if (!toolkit) continue;
      pinnedToolkits.add(toolkit);
      // Drop refs the provider no longer lists as ACTIVE so a revoked sibling
      // with a deleted account cannot fail the whole tool-router session.
      if (liveAccountIds && !liveAccountIds.has(accountId)) continue;
      const ids = accountIdsByToolkit.get(toolkit) ?? new Set<string>();
      ids.add(accountId);
      accountIdsByToolkit.set(toolkit, ids);
    }
    const reconnect = [...pinnedToolkits].filter((toolkit) => !accountIdsByToolkit.has(toolkit));
    const toolkits = requested.filter((toolkit) => !reconnect.includes(toolkit));
    const connectedAccounts: Record<string, string[]> = {};
    for (const [toolkit, ids] of accountIdsByToolkit) {
      connectedAccounts[toolkit] = [...ids].sort();
    }
    if (toolkits.length === 0) return { reconnect, connectedAccounts };
    let accounts = connectedAccounts;
    let remaining = toolkits;
    let stale = reconnect;
    for (;;) {
      try {
        return await this.executeSession(userId, remaining, stale, accounts);
      } catch (error) {
        if (!isStaleConnectedAccountError(error) || Object.keys(accounts).length === 0) throw error;
        // The account list was unavailable, so a deleted account slipped through. Drop the
        // accounts the refusal names (all of them when it names none we hold): an app left with
        // no account needs a reconnect, and the rest still get a session. Each pass drops at
        // least one account, so this ends.
        const named = staleAccountIds(error);
        const held = Object.values(accounts).flat();
        const dropAll = !held.some((id) => named.has(id));
        const kept: Record<string, string[]> = {};
        const dropped: string[] = [];
        for (const [toolkit, ids] of Object.entries(accounts)) {
          const live = dropAll ? [] : ids.filter((id) => !named.has(id));
          if (live.length > 0) kept[toolkit] = live;
          else dropped.push(toolkit);
        }
        getLogger().warn("composio connected accounts need reconnect", {
          "composio.toolkits": dropped.join(","),
        });
        accounts = kept;
        remaining = remaining.filter((toolkit) => !dropped.includes(toolkit));
        stale = [...stale, ...dropped];
        if (remaining.length === 0) return { reconnect: stale, connectedAccounts: {} };
      }
    }
  }

  private async executeSession(
    userId: string,
    toolkits: string[],
    reconnect: string[],
    connectedAccounts: Record<string, string[]>,
  ): Promise<{
    session?: ComposioSession;
    reconnect: string[];
    connectedAccounts: Record<string, string[]>;
  }> {
    const key = executeSessionKey(toolkits, connectedAccounts);
    const composio = await this.sdk();
    const existing = this.executeSessions.get(userId);
    if (existing?.key === key) {
      try {
        return {
          session: await composio.sessions.use(existing.sessionId),
          reconnect,
          connectedAccounts,
        };
      } catch {
        this.executeSessions.delete(userId);
      }
    }
    // Non-multi-account sessions cap connectedAccounts at one id per toolkit.
    // requireExplicitSelection would also break single-account / no-auth
    // execute paths that do not pass an account parameter.
    const needsMultiAccount = Object.values(connectedAccounts).some((ids) => ids.length >= 2);
    const session = await composio.create(userId, {
      manageConnections: false,
      sandbox: { enable: false },
      toolkits,
      ...(Object.keys(connectedAccounts).length > 0 ? { connectedAccounts } : {}),
      ...(needsMultiAccount
        ? {
            multiAccount: {
              enable: true,
              maxAccountsPerToolkit: 10,
              requireExplicitSelection: true,
            },
          }
        : {}),
    });
    this.executeSessions.set(userId, { sessionId: session.sessionId, key });
    return { session, reconnect, connectedAccounts };
  }

  async catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]> {
    const [directory, toolkits] = await Promise.all([
      this.directory(),
      this.connectedToolkits(composioOwner(context)),
    ]);
    // An expired account keeps its app listed so the user can still reconnect or remove it.
    const withAccount = toolkits.map((toolkit) => toolkit.slug);
    return filterCatalog(
      mergeCatalogWithConnected(directory, activeSlugs(toolkits), withAccount),
      query ?? "",
    ).map((item) => ({ ...item, connectorId: "composio" }));
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
    return this.directoryCache.get(() => this.loadDirectory());
  }

  private async loadDirectory(): Promise<ToolkitDirectoryEntry[]> {
    const session = await this.sessionFor("__rakazo_catalog__");
    const [toolkits, needsSetup] = await Promise.all([
      collectPages((cursor) => session.toolkits({ limit: 50, cursor })),
      // Without this lookup every app stays listed, as before.
      this.toolkitsNeedingSignInSetup().catch((error: unknown) => {
        getLogger().warn("composio sign-in setup lookup failed", {
          error: sanitizeIntegrationError(error),
        });
        return new Set<string>();
      }),
    ]);
    return toolkits.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkitDisplayName(toolkit),
      logo: toolkit.logo ?? null,
      noAuth: Boolean(toolkit.isNoAuth),
      ...(!toolkit.isNoAuth && needsSetup.has(composioSlugKey(toolkit.slug))
        ? { needsSignInSetup: true }
        : {}),
    }));
  }

  /**
   * Apps Composio has no managed sign-in for (Shopify, Twitter) connect only
   * once this project has its own auth config for them; until then hide them.
   */
  private async toolkitsNeedingSignInSetup(): Promise<Set<string>> {
    const composio = await this.sdk();
    const [toolkits, authConfigs] = await Promise.all([
      composio.toolkits.get({ limit: 1000 }),
      collectPages(async (cursor) => {
        const page = await composio.authConfigs.list({ limit: 100, cursor });
        return { items: page.items, cursor: page.nextCursor ?? undefined };
      }),
    ]);
    const configured = new Set(
      authConfigs
        .filter((config) => config.status === "ENABLED")
        .map((config) => composioSlugKey(config.toolkit.slug)),
    );
    return new Set(
      toolkits
        // A missing field is unknown, not "no managed sign-in".
        .filter((toolkit) => !toolkit.noAuth && toolkit.composioManagedAuthSchemes?.length === 0)
        .map((toolkit) => composioSlugKey(toolkit.slug))
        .filter((slug) => !configured.has(slug)),
    );
  }

  async listConnectedSlugs(userId: string): Promise<string[]> {
    return activeSlugs(await this.connectedToolkits(userId));
  }

  private async connectedToolkits(userId: string): Promise<ToolkitConnection[]> {
    const session = await this.sessionFor(userId);
    return collectPages((cursor) => session.toolkits({ isConnected: true, limit: 50, cursor }));
  }

  async listConnectedExternalIds(context: AdapterContext): Promise<string[]> {
    return this.listConnectedSlugs(composioOwner(context));
  }

  async listConnectedRefs(context: AdapterContext): Promise<string[]> {
    return this.accountIds(composioOwner(context), [], ["ACTIVE"], { signal: context.signal });
  }

  async listReconnectRefs(context: AdapterContext): Promise<string[]> {
    return this.accountIds(composioOwner(context), [], RECONNECT_STATUSES, {
      signal: context.signal,
    });
  }

  /** The app's own actions, not the session tools that only search and run them. */
  async listAppTools(context: AdapterContext, externalId: string): Promise<ConnectorTool[]> {
    context.signal.throwIfAborted();
    const [toolkit] = await this.canonicalizeToolkits([externalId]);
    if (!toolkit) return [];
    const composio = await this.sdk();
    const tools: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      context.signal.throwIfAborted();
      if (seen.size >= 200 || (cursor && seen.has(cursor))) {
        throw new Error("App tool catalog pagination did not terminate");
      }
      if (cursor) seen.add(cursor);
      const page = await composio
        .getClient()
        .tools.list({ toolkit_slug: toolkit, limit: 200, cursor }, { signal: context.signal });
      tools.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return asConnectorTools(tools);
  }

  private readonly accountTools = composioAccountTools(
    (context, app) => this.listAppTools(context, app),
    (context, connection) => this.sessionForExecute(composioOwner(context), [connection]),
    async (app) => {
      try {
        return (await this.directory()).some(
          ({ slug, noAuth }) => noAuth && composioSlugKey(slug) === composioSlugKey(app),
        );
      } catch (error) {
        if (!isComposioOutage(error)) throw error;
        getLogger().warn("Composio could not verify whether the app requires an account", {
          error: sanitizeIntegrationError(error),
        });
        return undefined;
      }
    },
  );

  resolveCall(call: ConnectorCall, context: AdapterContext) {
    return this.accountTools.resolveCall(call, context);
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const [personal, shared] = await Promise.all([
      this.discoverPersonalTools(context),
      this.accountTools.discoverTools(context),
    ]);
    return [...personal, ...shared];
  }

  private async discoverPersonalTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const scoped = new Set(scopedAccounts(context).map(({ id }) => id));
    const connections = connectedComposioConnections(context).filter(({ id }) => !scoped.has(id));
    if (connections.length === 0) return [];
    try {
      const { session } = await this.sessionForExecute(context.userId, connections);
      if (!session) return [];
      return asConnectorTools(await session.tools());
    } catch (error) {
      // An outage or a cancelled request hides the tools for this turn only.
      if (!isComposioOutage(error)) throw error;
      getLogger().warn("composio tool discovery unavailable", {
        error: sanitizeIntegrationError(error),
      });
      return [];
    }
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.route?.connectionId || isLazyCatalogControlRoute(call.route)) {
      yield* this.accountTools.execute(call, context);
      return;
    }
    const executed = [];
    try {
      const connections = connectedComposioConnections(context);
      const { session, reconnect, connectedAccounts } = await this.sessionForExecute(
        context.userId,
        connections,
      );
      const toolkits = connections.map((connection) => connection.externalId);
      const stale = reconnect.find((toolkit) => callUsesToolkit(call, toolkit, toolkits));
      if (stale) {
        getLogger().warn("composio connected accounts need reconnect", {
          "composio.toolkits": stale,
        });
        yield {
          type: "error",
          message: `The ${stale} connection is no longer active. Ask the user to reconnect ${stale}.`,
        };
        return;
      }
      if (!session) {
        yield { type: "error", message: "No active Composio connection for this tool." };
        return;
      }
      const planned = expandComposioMultiExecute(call.tool, call.args ?? {});
      const unpinned = planned.find(
        (item) => item.account && !accountIsPinned(connectedAccounts, item.tool, item.account),
      );
      if (unpinned) {
        yield {
          type: "error",
          message: `The account requested for ${unpinned.tool} is not connected to this workspace.`,
        };
        return;
      }
      for (const item of planned) {
        const result = await session.execute(
          item.tool,
          item.args,
          item.account ? { account: item.account } : undefined,
        );
        // A failed or hook-blocked call can come back with an empty error.
        if (result.error || result.resultType !== "completed") {
          const logIds = collectLogIds(executed);
          yield {
            type: "error",
            message: withSharedAccessHint(
              sanitizeIntegrationError(
                composioResultError(result.error || `${item.tool} failed`, result.data),
              ),
            ),
            ...(logIds.length > 0 ? { logIds } : {}),
          };
          return;
        }
        executed.push(result);
      }
      const result =
        executed.length === 1
          ? executed[0]!
          : { data: executed.map((item) => item.data), error: null };
      const logIds = collectLogIds(executed.length === 1 ? result : executed);
      const logId = logIds[0] ?? "";
      yield {
        type: "result",
        data: {
          data: sanitizePayload(result.data),
          logId,
          ...(logIds.length > 1 ? { logIds: logIds.slice(1).map((id) => ({ logId: id })) } : {}),
        },
      };
    } catch (error) {
      const logIds = collectLogIds(executed);
      yield {
        type: "error",
        message: withSharedAccessHint(sanitizeIntegrationError(error)),
        ...(logIds.length > 0 ? { logIds } : {}),
      };
    }
  }

  async begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): ReturnType<ManagedConnectorProvider["begin"]> {
    const session = await this.sessionFor(composioOwner(context));
    try {
      const connectionRequest = await session.authorize(request.provider, {
        callbackUrl: request.redirectUrl,
      });
      if (!connectionRequest.redirectUrl) {
        const account = await connectionRequest.waitForConnection(20_000).catch(() => undefined);
        return {
          authorizationUrl: null,
          state: account?.id || connectionRequest.id || request.provider,
          requiresCompletion:
            composioSlugKey(request.provider) === "gmail" ||
            Boolean(context.organizationId && (account?.id || connectionRequest.id)),
        };
      }
      if (!connectionRequest.id) throw new Error("Authorization has no connection request ID.");
      return {
        authorizationUrl: connectionRequest.redirectUrl,
        state: connectionRequest.id,
      };
    } catch (error) {
      if (isNoAuthToolkitError(error)) {
        return { authorizationUrl: null, state: request.provider };
      }
      if (isNoManagedAuthError(error)) {
        throw new ConnectorAuthUnavailableError({ cause: sanitizeIntegrationError(error) });
      }
      throw new Error(sanitizeIntegrationError(error));
    }
  }

  readonly prepareAccountIdentityLookup = composioAccountIdentity(
    (context, slug) =>
      this.accountIds(composioOwner(context), [slug], ["ACTIVE"], {
        signal: context.signal,
      }),
    async () => (await this.sdk()).tools,
  );

  async connectionReady(context: AdapterContext, slug: string): Promise<boolean> {
    const session = await this.sessionFor(composioOwner(context));
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
    // Legacy rows may store a toolkit slug. Begin's browser OAuth state may be a
    // connection-request id. Resolve either to a concrete connected-account id
    // before delete — never pass a raw request id to connectedAccounts.delete.
    const requestOptions = { signal: context.signal };
    let accountId: string | undefined;
    try {
      const listed = await this.listConnectedAccountIds(
        composioOwner(context),
        connectionRef,
        requestOptions,
      );
      accountId = listed[0];
      if (!accountId) {
        try {
          const { connectedAccounts } = await this.sdk();
          const account = await connectedAccounts.waitForConnection(connectionRef, 20_000);
          accountId = account?.id;
        } catch {
          // Not a resolvable request id; fall through to treat ref as an account id.
        }
      }
    } catch (error) {
      // Resolution failed before any DELETE — mark so callers can restore local retry state.
      if (error && typeof error === "object") {
        (error as { remoteRevokePreDelete?: boolean }).remoteRevokePreDelete = true;
      }
      throw error;
    }
    try {
      const { connectedAccounts } = await this.sdk();
      await connectedAccounts.delete(accountId ?? connectionRef, requestOptions);
    } catch (error) {
      // Already deleted upstream: the revoke goal is met.
      if (!isComposioNotFoundError(error)) throw error;
    }
  }

  async connectedAccountId(userId: string, slug: string): Promise<string | undefined> {
    const ids = await this.listConnectedAccountIds(userId, slug);
    return ids[0];
  }

  private async listActiveAccountIds(
    userId: string,
    toolkits: string[],
  ): Promise<Set<string> | null> {
    try {
      // A successful list is the allowlist, including empty. Only a thrown
      // lookup leaves filtering skipped so an outage does not strip every pin.
      return new Set(await this.accountIds(userId, toolkits, ["ACTIVE"]));
    } catch {
      return null;
    }
  }

  async listConnectedAccountIds(
    userId: string,
    slug: string,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<string[]> {
    try {
      const ids = await this.accountIds(userId, [slug], ["ACTIVE"], requestOptions);
      if (ids.length > 0) return ids;
    } catch {
      // List may be unavailable; fall through to toolkit metadata.
    }
    if (requestOptions?.signal?.aborted) {
      throw requestOptions.signal.reason instanceof Error
        ? requestOptions.signal.reason
        : new Error("Aborted");
    }
    const session = await this.sessionFor(userId);
    const toolkits = await collectPages(
      (cursor) => session.toolkits({ isConnected: true, limit: 50, cursor }),
      MAX_ACCOUNT_PAGES,
    );
    const id = toolkits.find(
      (item) =>
        composioSlugKey(item.slug) === composioSlugKey(slug) && item.connection?.isActive === true,
    )?.connection?.connectedAccount?.id;
    return id ? [id] : [];
  }

  private async accountIds(
    userId: string,
    toolkits: string[],
    statuses: ConnectedAccountStatus[],
    requestOptions?: { signal?: AbortSignal },
  ): Promise<string[]> {
    const accounts = await collectPages(async (cursor) => {
      const { connectedAccounts } = await this.sdk();
      const page = await connectedAccounts.list(
        {
          userIds: [userId],
          ...(toolkits.length > 0 ? { toolkitSlugs: toolkits } : {}),
          statuses,
          ...(cursor ? { cursor } : {}),
        },
        requestOptions,
      );
      return { items: page.items ?? [], cursor: page.nextCursor ?? undefined };
    }, MAX_ACCOUNT_PAGES);
    return accounts.map((item) => item.id).filter((id): id is string => Boolean(id));
  }

  /**
   * Cancel an in-flight browser OAuth authorization by its connection-request id.
   * Composio uses the connected-account nanoid as the request id (INITIATED until
   * OAuth finishes); deleting it invalidates the authorization URL so a revoke-win
   * cannot leave an untracked remote after the user completes the orphaned link.
   */
  async cancelAuthorizationRequest(requestId: string, context: AdapterContext): Promise<void> {
    const id = requestId.trim();
    if (!id) return;
    // Connection-request ids are connected-account nanoids. Delete directly so a
    // revoke-win begin does not wait for OAuth to finish, and the authorization
    // URL cannot later create an untracked remote. Ignore missing ids.
    try {
      const { connectedAccounts } = await this.sdk();
      await connectedAccounts.delete(id, { signal: context.signal });
    } catch (error) {
      if (!isComposioNotFoundError(error)) throw error;
    }
  }

  /**
   * Map a begin() state (connection-request id, account id, or provider slug) to
   * the connected-account id revoke must delete. Prefer unused remotes so a
   * second Gmail connect does not reuse the first account's id.
   */
  async resolveConnectedAccountId(
    userId: string,
    slug: string,
    currentRef: string | null | undefined,
    excludeIds: string[] = [],
    _spaceId?: string,
    organizationId?: string,
  ): Promise<string | undefined> {
    const excluded = new Set(excludeIds.filter(Boolean));
    const current = currentRef?.trim() || undefined;
    const slugKey = composioSlugKey(slug);

    if (current && composioSlugKey(current) !== slugKey) {
      try {
        const { connectedAccounts } = await this.sdk();
        const account = await connectedAccounts.waitForConnection(current, 20_000);
        if (account?.id && !excluded.has(account.id)) return account.id;
      } catch {
        // Request id could not be resolved. Do not fall back to another connected
        // account — that can attach a sibling's remote identity to this row.
      }
      return undefined;
    }

    const ids = await this.listConnectedAccountIds(composioOwner({ userId, organizationId }), slug);
    const available = ids.filter((id) => !excluded.has(id));
    return available.length === 1 ? available[0] : undefined;
  }

  /** The SDK loads on first use, so deployments without Composio never load it. */
  private async sdk(): Promise<ComposioClient> {
    if (!this.client) {
      const { Composio } = await import("@composio/core");
      this.client ??= new Composio(this.apiKey ? { apiKey: this.apiKey } : undefined);
    }
    return this.client;
  }
}

function isComposioNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return candidate.status === 404 || candidate.statusCode === 404;
}

function connectedComposioConnections(context: AdapterContext): ConnectedConnector[] {
  return (
    context.connectedConnections?.filter(
      (connection) => connection.connectorId === "composio" && !connection.organizationId,
    ) ??
    (context.connectedProviders ?? []).map((externalId) => ({
      id: `legacy:${externalId}`,
      connectorId: "composio",
      externalId,
      displayName: externalId,
    }))
  );
}
