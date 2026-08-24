import type { ResolveHostname } from "./remote-mcp.js";

type EmulatorRecord =
  | { provider: "pipedream"; operation: string; app?: string; accountId?: string }
  | {
      provider: "mcp";
      operation: string;
      host: string;
      args?: Record<string, unknown>;
      accountId?: string;
    }
  | { provider: "openapi"; operation: string; path: string; authenticated: boolean };

const PIPEDREAM_APPS = [
  { id: "app-linear", name_slug: "linear", name: "Linear" },
  { id: "app-airtable", name_slug: "airtable", name: "Airtable" },
  { id: "app-gmail", name_slug: "gmail", name: "Gmail" },
];

/** Deterministic HTTP/MCP boundary emulator used by integration and browser journeys. */
export class ThirdPartyConnectorEmulator {
  readonly records: EmulatorRecord[] = [];
  readonly resolveHostname: ResolveHostname = async () => [{ address: "203.0.113.10", family: 4 }];

  private readonly accountsByUser = new Map<string, Map<string, string[]>>();
  private readonly accountOwners = new Map<string, { externalUserId: string; app: string }>();
  private readonly pendingByUser = new Map<string, string[]>();
  private readonly nextAccountSequence = new Map<string, number>();

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "api.pipedream.com") return this.pipedream(url, init);
    if (url.hostname === "remote.mcp.pipedream.net" || url.hostname === "treg.to") {
      return this.mcp(url, init);
    }
    if (url.hostname === "mcp.example.test") return this.mcp(url, init);
    if (url.hostname === "api.example.test") return this.openapi(url, init);
    throw new Error(`Third-party connector emulator received unexpected URL ${url}`);
  };

  private async pipedream(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    if (url.pathname === "/v1/oauth/token") {
      this.records.push({ provider: "pipedream", operation: "token" });
      return Response.json({ access_token: "fake-pipedream-access-token", expires_in: 3_600 });
    }
    if (url.pathname === "/v1/connect/apps") {
      this.records.push({ provider: "pipedream", operation: "catalog" });
      return Response.json({ data: PIPEDREAM_APPS, page_info: {} });
    }
    if (url.pathname.endsWith("/tokens") && method === "POST") {
      const body = parseBody(init?.body);
      const externalUserId = String(body.external_user_id ?? "");
      const pending = this.pendingByUser.get(externalUserId) ?? [];
      pending.push("pending");
      this.pendingByUser.set(externalUserId, pending);
      this.records.push({ provider: "pipedream", operation: "begin" });
      return Response.json({ connect_link_url: "about:blank" });
    }
    if (url.pathname.endsWith("/accounts") && method === "GET") {
      const externalUserId = url.searchParams.get("external_user_id") ?? "";
      const requestedApp = url.searchParams.get("app") ?? undefined;
      const pending = this.pendingByUser.get(externalUserId) ?? [];
      if (requestedApp && pending.length > 0) {
        pending.pop();
        this.pendingByUser.set(externalUserId, pending);
        const byApp = this.accountsByUser.get(externalUserId) ?? new Map<string, string[]>();
        const ids = byApp.get(requestedApp) ?? [];
        const sequenceKey = `${externalUserId}:${requestedApp}`;
        const sequence = (this.nextAccountSequence.get(sequenceKey) ?? 0) + 1;
        this.nextAccountSequence.set(sequenceKey, sequence);
        const id = `apn_${requestedApp}_${sequence}`;
        ids.push(id);
        byApp.set(requestedApp, ids);
        this.accountsByUser.set(externalUserId, byApp);
        this.accountOwners.set(id, { externalUserId, app: requestedApp });
      }
      const byApp = this.accountsByUser.get(externalUserId) ?? new Map<string, string[]>();
      const data = [...byApp.entries()]
        .filter(([app]) => !requestedApp || app === requestedApp)
        .flatMap(([app, ids]) =>
          ids.map((id) => ({
            id,
            healthy: true,
            app: PIPEDREAM_APPS.find((candidate) => candidate.name_slug === app),
          })),
        );
      this.records.push({ provider: "pipedream", operation: "accounts", app: requestedApp });
      return Response.json({ data, page_info: {} });
    }
    const accountId = url.pathname.match(/\/accounts\/([^/]+)$/)?.[1];
    if (accountId && method === "DELETE") {
      const decoded = decodeURIComponent(accountId);
      const owner = this.accountOwners.get(decoded);
      if (owner) {
        const byApp = this.accountsByUser.get(owner.externalUserId);
        const ids = byApp?.get(owner.app) ?? [];
        const next = ids.filter((id) => id !== decoded);
        if (next.length === 0) byApp?.delete(owner.app);
        else byApp?.set(owner.app, next);
        this.accountOwners.delete(decoded);
      }
      this.records.push({
        provider: "pipedream",
        operation: "revoke",
        app: owner?.app,
        accountId: decoded,
      });
      return new Response(null, { status: 204 });
    }
    return Response.json(
      { error: `Unhandled Pipedream request ${method} ${url.pathname}` },
      {
        status: 404,
      },
    );
  }

  private async mcp(url: URL, init?: RequestInit): Promise<Response> {
    const request = parseBody(init?.body);
    const method = String(request.method ?? "");
    const id = request.id;
    const headers = new Headers(init?.headers);
    const app = headers.get("x-pd-app-slug") ?? undefined;
    const accountId = headers.get("x-pd-account-id") ?? undefined;
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "initialize") {
      return jsonRpc(id, {
        protocolVersion: String(
          (request.params as Record<string, unknown> | undefined)?.protocolVersion ?? "2025-06-18",
        ),
        capabilities: { tools: {} },
        serverInfo: { name: "rakazo-third-party-emulator", version: "1.0.0" },
      });
    }
    if (method === "tools/list") {
      this.records.push({
        provider: "mcp",
        operation: "tools/list",
        host: url.hostname,
        accountId: accountId ?? undefined,
      });
      return jsonRpc(id, {
        tools: [
          {
            name: "notes.write",
            description: "Write a deterministic emulated note",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      });
    }
    if (method === "tools/call") {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      this.records.push({
        provider: "mcp",
        operation: String(params.name ?? "unknown"),
        host: url.hostname,
        args,
        accountId: accountId ?? undefined,
      });
      const result = { ok: true, app, accountId: accountId ?? null, text: args.text ?? null };
      return jsonRpc(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    }
    return jsonRpcError(id, -32601, `Unhandled MCP method ${method}`);
  }

  private async openapi(url: URL, init?: RequestInit): Promise<Response> {
    if (url.pathname === "/openapi.json") {
      return Response.json({
        openapi: "3.1.0",
        servers: [{ url: "https://api.example.test/v1" }],
        paths: {
          "/contacts/{contactId}": {
            get: {
              operationId: "getContact",
              summary: "Get one contact",
              parameters: [
                {
                  name: "contactId",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
            },
          },
        },
      });
    }
    const authenticated = new Headers(init?.headers).has("authorization");
    this.records.push({
      provider: "openapi",
      operation: init?.method ?? "GET",
      path: url.pathname,
      authenticated,
    });
    return Response.json({ ok: true, contactId: url.pathname.split("/").at(-1) });
  }
}

function parseBody(body: RequestInit["body"] | undefined): Record<string, unknown> {
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  }
  return {};
}

function jsonRpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}
