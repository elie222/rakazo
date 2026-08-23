import { createHmac } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { collectPages, filterCatalog } from "./composio-connector.js";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import {
  callRemoteMcpTool,
  listRemoteMcpTools,
  type RemoteTransportDependencies,
} from "./remote-mcp.js";

const API_BASE = "https://api.pipedream.com";
const MCP_ENDPOINT = "https://remote.mcp.pipedream.net/v3";
const DIRECTORY_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface PipedreamConnectorConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: "development" | "production";
  identitySecret: string;
}

export interface PipedreamEnvironmentValues {
  pipedreamClientId?: string;
  pipedreamClientSecret?: string;
  pipedreamProjectId?: string;
  pipedreamEnvironment?: string;
  encryptionKey: string;
}

export function pipedreamConfigFromEnv(
  values: PipedreamEnvironmentValues,
): PipedreamConnectorConfig {
  return {
    clientId: values.pipedreamClientId ?? "",
    clientSecret: values.pipedreamClientSecret ?? "",
    projectId: values.pipedreamProjectId ?? "",
    environment: values.pipedreamEnvironment === "production" ? "production" : "development",
    identitySecret: values.encryptionKey,
  };
}

export type PipedreamConnectorDependencies = RemoteTransportDependencies;

type PipedreamApp = {
  id: string;
  name_slug: string;
  name: string;
  img_src?: string;
};

type PipedreamAccount = {
  id: string;
  healthy?: boolean;
  dead?: boolean;
  app?: PipedreamApp;
};

export function isPipedreamEnabled(config: Partial<PipedreamConnectorConfig>): boolean {
  return Boolean(
    config.clientId &&
      config.clientSecret &&
      config.projectId &&
      config.environment &&
      config.identitySecret &&
      !process.env.VITEST,
  );
}

export class PipedreamConnector implements ManagedConnectorProvider {
  private accessToken?: { value: string; expiresAt: number };
  private accessTokenRequest?: Promise<string>;
  private directory?: { value: PipedreamApp[]; expiresAt: number };
  private directoryRequest?: Promise<PipedreamApp[]>;

  constructor(
    private readonly config: PipedreamConnectorConfig,
    private readonly dependencies: PipedreamConnectorDependencies = {},
  ) {}

  describe() {
    return {
      id: "pipedream",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]> {
    const [apps, connected] = await Promise.all([
      this.apps(),
      this.listConnectedExternalIds(context),
    ]);
    const connectedSet = new Set(connected);
    return filterCatalog(
      apps.map((app) => ({
        connectorId: "pipedream",
        slug: app.name_slug,
        name: app.name,
        logo: app.img_src ?? null,
        connected: connectedSet.has(app.name_slug),
        noAuth: false,
      })),
      query ?? "",
    );
  }

  async warmDirectory(): Promise<void> {
    await this.apps();
  }

  async listConnectedExternalIds(context: AdapterContext): Promise<string[]> {
    const accounts = await this.accounts(context);
    return [
      ...new Set(
        accounts
          .filter((account) => account.healthy !== false && account.dead !== true)
          .map((account) => account.app?.name_slug)
          .filter((slug): slug is string => Boolean(slug)),
      ),
    ];
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const apps =
      context.connectedConnections
        ?.filter((connection) => connection.connectorId === "pipedream")
        .map((connection) => connection.externalId) ?? [];
    if (apps.length === 0) return [];
    const token = await this.token();
    const groups = await Promise.all(
      [...new Set(apps)].slice(0, 20).map(async (app) => {
        const tools = await listRemoteMcpTools({
          endpoint: MCP_ENDPOINT,
          headers: this.mcpHeaders(context, app, token),
          signal: context.signal,
          fetch: this.dependencies.fetch,
          resolveHostname: this.dependencies.resolveHostname,
        });
        return tools.map((tool) => ({
          ...tool,
          route: { connectorId: "pipedream", resourceId: app, toolName: tool.name },
        }));
      }),
    );
    return groups.flat();
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const app = call.route?.resourceId;
    if (!app) {
      yield { type: "error", message: "Pipedream app route is missing" };
      return;
    }
    let token: string | undefined;
    try {
      token = await this.token();
      const result = await callRemoteMcpTool(
        {
          endpoint: MCP_ENDPOINT,
          headers: this.mcpHeaders(context, app, token),
          signal: context.signal,
          fetch: this.dependencies.fetch,
          resolveHostname: this.dependencies.resolveHostname,
        },
        call.route?.toolName ?? call.tool,
        call.args,
      );
      yield { type: "result", data: redactConnectorPayload(result, [token]) };
    } catch (error) {
      yield {
        type: "error",
        message: sanitizeConnectorError(error, token ? [token] : []),
      };
    }
  }

  async begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }> {
    const response = await this.request<{ connect_link_url: string }>(
      `/v1/connect/${encodeURIComponent(this.config.projectId)}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          external_user_id: this.externalUserId(context),
          success_redirect_uri: request.redirectUrl,
          error_redirect_uri: request.redirectUrl,
          scope: "connect:accounts:read connect:accounts:write",
        }),
      },
      context.signal,
    );
    const url = new URL(response.connect_link_url);
    url.searchParams.set("app", request.provider);
    return { authorizationUrl: url.toString(), state: request.provider };
  }

  async complete(request: { state: string }): Promise<{ connectionRef: string }> {
    return { connectionRef: request.state };
  }

  async connectionReady(context: AdapterContext, externalId: string): Promise<boolean> {
    const accounts = await this.accounts(context, externalId);
    return accounts.some(
      (account) =>
        account.app?.name_slug === externalId && account.healthy !== false && account.dead !== true,
    );
  }

  async revoke(externalId: string, context: AdapterContext): Promise<void> {
    const accounts = await this.accounts(context, externalId);
    await Promise.all(
      accounts
        .filter((account) => account.app?.name_slug === externalId)
        .map((account) =>
          this.request(
            `/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts/${encodeURIComponent(account.id)}`,
            { method: "DELETE" },
            context.signal,
          ),
        ),
    );
  }

  private externalUserId(context: AdapterContext): string {
    return `rkz_${createHmac("sha256", this.config.identitySecret)
      .update(`${context.workspaceId}:${context.userId}`)
      .digest("hex")}`;
  }

  private mcpHeaders(
    context: AdapterContext,
    app: string,
    accessToken: string,
  ): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      "x-pd-project-id": this.config.projectId,
      "x-pd-environment": this.config.environment,
      "x-pd-external-user-id": this.externalUserId(context),
      "x-pd-app-slug": app,
    };
  }

  private async apps(): Promise<PipedreamApp[]> {
    if (this.directory && this.directory.expiresAt > Date.now()) return this.directory.value;
    if (this.directoryRequest) return this.directoryRequest;
    this.directoryRequest = this.loadApps();
    try {
      return await this.directoryRequest;
    } finally {
      this.directoryRequest = undefined;
    }
  }

  private async loadApps(): Promise<PipedreamApp[]> {
    const apps: PipedreamApp[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: "100", has_actions: "true" });
      if (after) query.set("after", after);
      const response = await this.request<{
        data?: PipedreamApp[];
        page_info?: { end_cursor?: string };
      }>(`/v1/connect/apps?${query}`);
      apps.push(...(response.data ?? []));
      after = response.page_info?.end_cursor;
      if (!after || apps.length >= 5_000) break;
    }
    this.directory = { value: apps, expiresAt: Date.now() + DIRECTORY_TTL_MS };
    return apps;
  }

  private async accounts(context: AdapterContext, app?: string): Promise<PipedreamAccount[]> {
    return collectPages(async (after) => {
      const query = new URLSearchParams({
        external_user_id: this.externalUserId(context),
        limit: "100",
      });
      if (app) query.set("app", app);
      if (after) query.set("after", after);
      const response = await this.request<{
        data?: PipedreamAccount[];
        page_info?: { end_cursor?: string };
      }>(
        `/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts?${query}`,
        {},
        context.signal,
      );
      return { items: response.data ?? [], cursor: response.page_info?.end_cursor };
    }, 20);
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const token = await this.token();
    const response = await (this.dependencies.fetch ?? globalThis.fetch)(`${API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-pd-environment": this.config.environment,
        ...init.headers,
      },
      signal: combineSignals(signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
    });
    const body = await response.text();
    if (!response.ok) {
      if (response.status === 401) this.accessToken = undefined;
      throw new Error(
        sanitizeConnectorError(`Pipedream returned HTTP ${response.status}: ${body}`, [token]),
      );
    }
    return (body ? JSON.parse(body) : {}) as T;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    if (this.accessTokenRequest) return this.accessTokenRequest;
    this.accessTokenRequest = this.fetchToken();
    try {
      return await this.accessTokenRequest;
    } finally {
      this.accessTokenRequest = undefined;
    }
  }

  private async fetchToken(): Promise<string> {
    const response = await (this.dependencies.fetch ?? globalThis.fetch)(
      `${API_BASE}/v1/oauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          scope: "connect:*",
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !body.access_token) {
      throw new Error(`Pipedream authentication failed: ${body.error ?? response.status}`);
    }
    this.accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3_600) * 1_000,
    };
    return body.access_token;
  }
}
