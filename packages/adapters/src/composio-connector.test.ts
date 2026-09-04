import type { AdapterContext, ConnectorEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { composioToolkitDirectory } from "./composio-catalog-cache.js";
import {
  asConnectorTools,
  ComposioConnector,
  CompositeConnector,
  collectLogIds,
  collectPages,
  executeSessionKey,
  filterCatalog,
  isComposioEnabled,
  isNoAuthToolkitError,
  mergeConnectedPlugins,
  needsLivePluginSync,
  planLiveConnectionSync,
  sanitizeComposioError,
} from "./composio-connector.js";
import { DestinationEmulator } from "./destination-emulator.js";

const composioSdkState = vi.hoisted(() => ({
  created: [] as Array<{ userId: string; config: Record<string, unknown> }>,
  directoryFails: false,
  executions: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  sessions: new Map<
    string,
    {
      sessionId: string;
      toolkits?: () => Promise<{
        items: Array<{
          slug: string;
          name: string;
          logo: string | null;
          isNoAuth: boolean;
          connection?: { isActive?: boolean; connectedAccount?: { id: string } };
        }>;
        cursor?: string;
      }>;
      tools?: () => Promise<unknown[]>;
      execute?: (
        tool: string,
        args: Record<string, unknown>,
      ) => Promise<{
        data: Record<string, unknown>;
        error: null;
        logId: string;
      }>;
    }
  >(),
}));

vi.mock("@composio/core", () => ({
  Composio: class {
    readonly sessions = {
      use: async (sessionId: string) => {
        const session = composioSdkState.sessions.get(sessionId);
        if (!session) throw new Error(`unknown session ${sessionId}`);
        return session;
      },
    };

    async create(userId: string, config: Record<string, unknown>) {
      composioSdkState.created.push({ userId, config });
      const toolkits = Array.isArray(config.toolkits) ? config.toolkits : [];
      if (toolkits.length === 0) {
        const session = {
          sessionId: "catalog-session",
          toolkits: async () => {
            if (composioSdkState.directoryFails) throw new Error("directory unavailable");
            return {
              items: [
                {
                  slug: "GITHUB",
                  name: "GitHub",
                  logo: null,
                  isNoAuth: false,
                  connection: { isActive: true, connectedAccount: { id: "ca-github" } },
                },
              ],
            };
          },
        };
        composioSdkState.sessions.set(session.sessionId, session);
        return session;
      }

      const scopedToCanonicalGithub = toolkits.includes("GITHUB");
      const session = {
        sessionId: scopedToCanonicalGithub ? "github-session" : "unscoped-session",
        tools: async () =>
          scopedToCanonicalGithub
            ? [
                {
                  type: "function",
                  function: {
                    name: "GITHUB_GET_REPOS",
                    description: "List GitHub repositories",
                    parameters: { type: "object", properties: {} },
                  },
                },
              ]
            : [],
        execute: async (tool: string, args: Record<string, unknown>) => {
          composioSdkState.executions.push({ tool, args });
          return { data: { ok: true }, error: null, logId: "log-github" };
        },
      };
      composioSdkState.sessions.set(session.sessionId, session);
      return session;
    }
  },
}));

describe("composio tool mapping", () => {
  it("maps OpenAI-style session tools and raw slugs", () => {
    const tools = asConnectorTools([
      {
        type: "function",
        function: {
          name: "COMPOSIO_SEARCH_TOOLS",
          description: "Search tools",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
      {
        slug: "HACKERNEWS_GET_USER",
        description: "Look up a public HN profile",
        inputParameters: { type: "object", properties: { username: { type: "string" } } },
      },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "COMPOSIO_SEARCH_TOOLS",
      "HACKERNEWS_GET_USER",
    ]);
    expect(tools[1]?.inputSchema).toMatchObject({ properties: { username: { type: "string" } } });
  });

  it("retains provider route metadata independently of the tool name", async () => {
    const destination = new DestinationEmulator();
    const events: ConnectorEvent[] = [];
    const composio = {
      describe: () => ({ ...destination.describe(), id: "composio" }),
      discoverTools: async () => [
        {
          name: "destination.write",
          description: "shadow",
          inputSchema: {},
          route: { connectorId: "composio", toolName: "destination.write" },
        } satisfies ConnectorTool,
      ],
      execute: async function* () {
        yield { type: "result", data: { provider: "composio" } } as ConnectorEvent;
      },
    } as never;
    const connector = new CompositeConnector(destination, [composio]);
    const context = { userId: "u" } as AdapterContext;
    for await (const event of connector.execute(
      {
        tool: "destination.write",
        args: {},
        executionId: "x",
        route: { connectorId: "composio", toolName: "destination.write" },
      },
      context,
    ))
      events.push(event);
    expect(events).toEqual([{ type: "result", data: { provider: "composio" } }]);
  });

  it("logs sanitized connector discovery failures", async () => {
    const destination = new DestinationEmulator();
    const failing = {
      describe: () => ({ ...destination.describe(), id: "failing" }),
      discoverTools: async () => {
        throw new Error("denied ak_secretvaluehere");
      },
      execute: async function* () {},
    } as never;
    const connector = new CompositeConnector(destination, [failing]);
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));

    try {
      await expect(connector.discoverTools({ userId: "u" } as AdapterContext)).resolves.toEqual([
        expect.objectContaining({ name: "destination.write" }),
      ]);
      expect(sink.events[0]).toMatchObject({
        message: "connector discovery failed",
        "connector.id": "failing",
      });
      const logged = JSON.stringify(sink.events);
      expect(logged).toContain("[redacted]");
      expect(logged).not.toContain("ak_secretvaluehere");
    } finally {
      installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
    }
  });

  it("redacts project keys from errors", () => {
    expect(sanitizeComposioError("denied ak_secretvaluehere")).toContain("[redacted]");
    expect(sanitizeComposioError("denied ak_secretvaluehere")).not.toContain("ak_secret");
    expect(sanitizeComposioError("COMPOSIO_API_KEY=ak_shouldnotleak")).not.toContain(
      "ak_shouldnotleak",
    );
  });

  it("paginates until the cursor ends", async () => {
    const pages = [
      { items: ["gmail", "github"], cursor: "page-2" },
      { items: ["slack"], cursor: undefined },
    ];
    const items = await collectPages(async (cursor) => {
      if (!cursor) return pages[0]!;
      return pages[1]!;
    });
    expect(items).toEqual(["gmail", "github", "slack"]);
  });

  it("treats Composio no-auth toolkit errors as in-app connect", () => {
    expect(
      isNoAuthToolkitError(
        new Error(
          '400 {"error":{"message":"Toolkit hackernews does not require authentication.","slug":"ToolRouterV2_ToolkitsIsNoAuth"}}',
        ),
      ),
    ).toBe(true);
    expect(isNoAuthToolkitError(new Error("redirect required"))).toBe(false);
  });

  it("collects nested Composio log ids", () => {
    expect(
      collectLogIds({
        logId: "",
        data: { results: [{ log_id: "log_abc123", slug: "HACKERNEWS_GET_USER" }] },
      }),
    ).toEqual(["log_abc123"]);
  });

  it("keys execute sessions by sorted unique toolkits", () => {
    expect(executeSessionKey(["hackernews", "gmail", "hackernews"])).toBe("gmail,hackernews");
    expect(executeSessionKey(["github", "GITHUB"])).toBe("github");
    expect(executeSessionKey([])).toBe("");
  });

  it("uses catalog-canonical toolkit slugs without preloading every tool", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.executions.length = 0;
    composioSdkState.sessions.clear();
    composioToolkitDirectory.invalidate();

    const connector = new ComposioConnector();
    const context: AdapterContext = {
      operationId: "composio-canonical-slug",
      traceId: "composio-canonical-slug",
      spaceId: "workspace",
      userId: "user-1",
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: "connection-github",
          connectorId: "composio",
          externalId: "github",
          displayName: "GitHub",
        },
      ],
    };

    await expect(connector.discoverTools(context)).resolves.toContainEqual(
      expect.objectContaining({ name: "GITHUB_GET_REPOS" }),
    );
    expect(
      composioSdkState.created.map(({ userId, config }) => ({
        userId,
        toolkits: config.toolkits,
        sessionPreset: config.sessionPreset,
      })),
    ).toEqual([
      { userId: "__rakazo_catalog__", toolkits: undefined, sessionPreset: undefined },
      { userId: "user-1", toolkits: ["GITHUB"], sessionPreset: undefined },
    ]);

    const events: ConnectorEvent[] = [];
    for await (const event of connector.execute(
      {
        tool: "GITHUB_GET_REPOS",
        args: { owner: "composio" },
        executionId: "composio-canonical-execution",
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "result" }));
    expect(composioSdkState.executions).toEqual([
      { tool: "GITHUB_GET_REPOS", args: { owner: "composio" } },
    ]);
    await expect(connector.connectionReady(context, "github")).resolves.toBe(true);
    await expect(connector.connectedAccountId("user-1", "github")).resolves.toBe("ca-github");
  });

  it("uses Composio slug casing when the toolkit directory is unavailable", async () => {
    composioSdkState.created.length = 0;
    composioSdkState.sessions.clear();
    composioSdkState.directoryFails = true;
    composioToolkitDirectory.invalidate();

    try {
      const connector = new ComposioConnector();
      const context = {
        operationId: "composio-directory-fallback",
        traceId: "composio-directory-fallback",
        spaceId: "workspace",
        userId: "user-1",
        signal: new AbortController().signal,
        connectedConnections: [
          {
            id: "connection-github",
            connectorId: "composio",
            externalId: "github",
            displayName: "GitHub",
          },
        ],
      } satisfies AdapterContext;

      await expect(connector.discoverTools(context)).resolves.toContainEqual(
        expect.objectContaining({ name: "GITHUB_GET_REPOS" }),
      );
      expect(composioSdkState.created.at(-1)?.config.toolkits).toEqual(["GITHUB"]);
    } finally {
      composioSdkState.directoryFails = false;
      composioToolkitDirectory.invalidate();
    }
  });

  it("merges live Composio slugs onto pending DB plugin rows", () => {
    const merged = mergeConnectedPlugins(
      [
        { provider: "github", displayName: "GitHub", status: "connected" },
        { provider: "gmail", displayName: "Gmail", status: "pending" },
        { provider: "linear", displayName: "Linear", status: "revoked" },
      ],
      ["gmail", "github", "notion"],
    );
    expect(merged).toEqual([
      { provider: "github", displayName: "GitHub" },
      { provider: "gmail", displayName: "Gmail" },
    ]);
  });

  it("reconciles Composio slugs without case sensitivity", () => {
    expect(
      mergeConnectedPlugins(
        [{ provider: "github", displayName: "GitHub", status: "pending" }],
        ["GITHUB"],
      ),
    ).toEqual([{ provider: "github", displayName: "GitHub" }]);
    expect(
      planLiveConnectionSync(
        [{ id: "row-gh", provider: "github", status: "pending", displayName: "GitHub" }],
        ["GITHUB"],
      ),
    ).toEqual({ connectIds: ["row-gh"], revokeIds: [] });
  });

  it("only fetches live Composio slugs when a Rakazo row is still pending or errored", () => {
    expect(needsLivePluginSync([{ status: "connected" }, { status: "revoked" }])).toBe(false);
    expect(needsLivePluginSync([{ status: "pending" }])).toBe(true);
    expect(needsLivePluginSync([{ status: "error" }])).toBe(true);
  });

  it("keeps DB-connected plugins when live Composio listing is empty", () => {
    expect(
      mergeConnectedPlugins(
        [{ provider: "github", displayName: "GitHub", status: "connected" }],
        [],
      ),
    ).toEqual([{ provider: "github", displayName: "GitHub" }]);
  });

  it("plans DB sync when Composio is connected but Rakazo is still pending", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-gmail", provider: "gmail", status: "pending", displayName: "Gmail" },
          { id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" },
        ],
        ["gmail", "slack"],
      ),
    ).toEqual({
      connectIds: ["row-gmail"],
      revokeIds: [],
    });
  });

  it("does not create connection rows for live slugs that have no workspace row", () => {
    expect(
      planLiveConnectionSync(
        [{ id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" }],
        ["github", "slack"],
      ),
    ).toEqual({ connectIds: [], revokeIds: [] });
  });

  it("reconnects existing error or revoked rows instead of inserting duplicates", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-err", provider: "gmail", status: "error", displayName: "Gmail" },
          { id: "row-old", provider: "slack", status: "revoked", displayName: "Slack" },
          { id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" },
        ],
        ["gmail", "slack", "github", "slack"],
      ),
    ).toEqual({
      connectIds: ["row-err", "row-old"],
      revokeIds: [],
    });
  });

  it("revokes abandoned pending or error rows after a successful live listing", () => {
    expect(
      planLiveConnectionSync(
        [
          { id: "row-gmail", provider: "gmail", status: "pending", displayName: "Gmail" },
          { id: "row-dup", provider: "gmail", status: "pending", displayName: "Gmail" },
          { id: "row-err", provider: "slack", status: "error", displayName: "Slack" },
          { id: "row-gh", provider: "github", status: "connected", displayName: "GitHub" },
        ],
        ["gmail"],
      ),
    ).toEqual({
      connectIds: ["row-gmail"],
      revokeIds: ["row-dup", "row-err"],
    });
  });

  it("filters the catalog by name or slug", () => {
    const items = [
      { slug: "github", name: "GitHub", logo: null, connected: false, noAuth: false },
      { slug: "hackernews", name: "Hacker News", logo: null, connected: false, noAuth: true },
    ];
    expect(filterCatalog(items, "hacker").map((item) => item.slug)).toEqual(["hackernews"]);
  });
});

describe("Composio during pnpm test", () => {
  it("does not construct a live Platform client under Vitest", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isComposioEnabled("ck_must_not_call_live")).toBe(false);
  });
});
