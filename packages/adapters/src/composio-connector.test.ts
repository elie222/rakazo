import type { Composio } from "@composio/core";
import type { AdapterContext, ConnectorEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
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

  it("keeps the toolkit route so account selection is scoped to the right app", () => {
    expect(
      asConnectorTools([
        { slug: "GMAIL_SEND_EMAIL", toolkit: { slug: "GMAIL" }, inputParameters: {} },
      ])[0]?.route?.resourceId,
    ).toBe("gmail");
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
    expect(executeSessionKey([])).toBe("");
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

  it("passes the selected connected-account id to Composio without leaking the selector into tool args", async () => {
    const calls: Array<{
      config: unknown;
      tool: string;
      args: Record<string, unknown>;
      options: unknown;
    }> = [];
    const session = {
      sessionId: "session-1",
      execute: async (tool: string, args: Record<string, unknown>, options?: unknown) => {
        calls.push({ config: undefined, tool, args, options });
        return { data: { ok: true } };
      },
    };
    const fake = {
      create: async (_userId: string, config: unknown) => {
        calls[0] = { config, tool: "", args: {}, options: undefined };
        return session;
      },
      sessions: { use: async () => session },
    } as unknown as Composio;
    const connector = new ComposioConnector(fake);
    const context = {
      userId: "u",
      connectedConnections: [
        {
          id: "one",
          connectorId: "composio",
          externalId: "GMAIL",
          displayName: "Personal",
          providerRef: "ca_one",
        },
        {
          id: "two",
          connectorId: "composio",
          externalId: "GMAIL",
          displayName: "Work",
          providerRef: "ca_two",
        },
      ],
      signal: new AbortController().signal,
    } as AdapterContext;
    const events: ConnectorEvent[] = [];
    for await (const event of connector.execute(
      {
        tool: "GMAIL_SEND_EMAIL",
        args: { account: "Work", to: "hello@example.com" },
        executionId: "execution-1",
        route: { connectorId: "composio", toolName: "GMAIL_SEND_EMAIL", resourceId: "gmail" },
      },
      context,
    ))
      events.push(event);
    expect(calls[0]?.config).toMatchObject({
      connectedAccounts: { gmail: ["ca_one", "ca_two"] },
      multiAccount: { enable: true, requireExplicitSelection: true },
    });
    expect(calls[1]).toMatchObject({
      tool: "GMAIL_SEND_EMAIL",
      args: { to: "hello@example.com" },
      options: { account: "ca_two" },
    });
    expect(events).toEqual([{ type: "result", data: { data: { ok: true }, logId: "" } }]);

    const ambiguousEvents: ConnectorEvent[] = [];
    for await (const event of connector.execute(
      {
        tool: "GMAIL_SEND_EMAIL",
        args: { to: "hello@example.com" },
        executionId: "execution-2",
        route: { connectorId: "composio", toolName: "GMAIL_SEND_EMAIL", resourceId: "gmail" },
      },
      context,
    )) {
      ambiguousEvents.push(event);
    }
    expect(ambiguousEvents).toEqual([
      { type: "error", message: "Choose a connected gmail account before running this action." },
    ]);
    expect(calls).toHaveLength(2);
  });
});

describe("Composio during pnpm test", () => {
  it("does not construct a live Platform client under Vitest", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isComposioEnabled("ck_must_not_call_live")).toBe(false);
  });
});
