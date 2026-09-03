import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  assertConnectorToolArgs,
  catalogEntries,
  catalogGroupLabel,
  DIRECT_TOOL_LIMIT,
  disambiguateInstalledToolNames,
  executeLazyCatalogControl,
  formatNameIndexText,
  lazyCatalogTools,
  loadCatalogEntry,
  NAME_INDEX_MAX_NAMES,
  resolveCatalogCall,
  SELECTED_SCHEMA_MAX_BYTES,
  searchCatalog,
  TOOL_SEARCH_LIMIT,
  uniquifyInstalledToolName,
} from "./lazy-tool-catalog.js";

function tools(count: number, group = "source"): ConnectorTool[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `tool_${String(index).padStart(2, "0")}`,
    description: "Shared catalog result",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    route: {
      connectorId: "test",
      resourceId: `source-${index}`,
      toolName: `tool-${index}`,
      catalogGroup: group,
    },
  }));
}

function multiGroupTools(): ConnectorTool[] {
  return [
    {
      name: "mcp__gmail__send",
      description: "Send mail",
      inputSchema: { type: "object", properties: { to: { type: "string" } } },
      route: {
        connectorId: "mcp",
        resourceId: "srv-gmail",
        toolName: "send",
        catalogGroup: "gmail",
      },
    },
    {
      name: "mcp__gmail__read",
      description: "Read mail",
      inputSchema: { type: "object", properties: {} },
      route: {
        connectorId: "mcp",
        resourceId: "srv-gmail",
        toolName: "read",
        catalogGroup: "gmail",
      },
    },
    {
      name: "mcp__gmail__list",
      description: "List mail",
      inputSchema: { type: "object", properties: {} },
      route: {
        connectorId: "mcp",
        resourceId: "srv-gmail",
        toolName: "list",
        catalogGroup: "gmail",
      },
    },
    {
      name: "mcp__hubspot__list_contacts",
      description: "List contacts",
      inputSchema: { type: "object", properties: {} },
      route: {
        connectorId: "mcp",
        resourceId: "srv-hubspot",
        toolName: "list_contacts",
        catalogGroup: "hubspot",
      },
    },
    {
      name: "mcp__hubspot__get_deal",
      description: "Get deal",
      inputSchema: { type: "object", properties: {} },
      route: {
        connectorId: "mcp",
        resourceId: "srv-hubspot",
        toolName: "get_deal",
        catalogGroup: "hubspot",
      },
    },
  ];
}

describe("lazy tool catalog", () => {
  it("exposes tools directly at the limit and switches to lazy wrappers above it", () => {
    expect(tools(DIRECT_TOOL_LIMIT)).toHaveLength(20);
    expect(tools(DIRECT_TOOL_LIMIT + 1)).toHaveLength(21);
    expect(lazyCatalogTools("mcp", "mcp", "MCP")).toHaveLength(3);
    expect(lazyCatalogTools("installed", "installed", "API").map((tool) => tool.name)).toEqual([
      "installed_search_tools",
      "installed_load_tool",
      "installed_execute_tool",
    ]);
    expect(lazyCatalogTools("mcp", "mcp", "MCP").map((tool) => tool.name)).toEqual([
      "mcp_search_tools",
      "mcp_load_tool",
      "mcp_execute_tool",
    ]);
    expect(lazyCatalogTools("mcp", "mcp", "MCP")[0]?.description).toContain(
      "Empty query lists sources",
    );
    expect(lazyCatalogTools("mcp", "mcp", "MCP")[0]?.inputSchema).not.toMatchObject({
      required: expect.arrayContaining(["query"]),
    });
  });

  it("embeds a compact name index in the search description when it fits", () => {
    const entries = catalogEntries(multiGroupTools());
    const [search] = lazyCatalogTools("mcp", "mcp", "MCP", entries);
    expect(search?.description).toContain("gmail:");
    expect(search?.description).toContain("list, read, send");
    expect(search?.description).toContain("hubspot:");
    expect(search?.description).toContain("get_deal, list_contacts");
    expect(search?.description).not.toContain("inputSchema");
    expect(search?.description).not.toContain("Send mail");
  });

  it("returns an empty catalog as an empty tool list", () => {
    expect(catalogEntries([])).toEqual([]);
    expect(searchCatalog([], { query: "anything" })).toEqual({ tools: [] });
  });

  it("lists grouped names for an empty query without dumping schemas", () => {
    const result = searchCatalog(catalogEntries(multiGroupTools()), {});
    expect(result).toEqual({
      index: [
        { group: "gmail", names: ["list", "read", "send"] },
        { group: "hubspot", names: ["get_deal", "list_contacts"] },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("inputSchema");
    expect(JSON.stringify(result)).not.toContain("Send mail");
  });

  it("expands one group to its names", () => {
    expect(searchCatalog(catalogEntries(multiGroupTools()), { group: "gmail" })).toEqual({
      group: "gmail",
      names: ["list", "read", "send"],
    });
    expect(searchCatalog(catalogEntries(multiGroupTools()), { group: "missing" })).toEqual({
      group: "missing",
      names: [],
      error: "Unknown or empty group",
    });
  });

  it("keeps case-distinct group labels separate when filtering", () => {
    const mixed = [
      ...tools(2, "Gmail").map((tool, index) => ({
        ...tool,
        name: `Upper_${index}`,
        route: { ...tool.route!, toolName: `Upper_${index}` },
      })),
      ...tools(2, "gmail").map((tool, index) => ({
        ...tool,
        name: `lower_${index}`,
        route: { ...tool.route!, toolName: `lower_${index}` },
      })),
    ];
    const entries = catalogEntries(mixed);
    expect(searchCatalog(entries, { group: "Gmail" })).toEqual({
      group: "Gmail",
      names: ["Upper_0", "Upper_1"],
    });
    expect(searchCatalog(entries, { group: "gmail" })).toEqual({
      group: "gmail",
      names: ["lower_0", "lower_1"],
    });
    const listed = searchCatalog(entries, {});
    expect("index" in listed && listed.index).toEqual(
      [
        { group: "Gmail", names: ["Upper_0", "Upper_1"] },
        { group: "gmail", names: ["lower_0", "lower_1"] },
      ].sort((left, right) => left.group.localeCompare(right.group)),
    );
  });

  it("returns a group count when expanding an over-budget source", () => {
    const oversized = Array.from({ length: NAME_INDEX_MAX_NAMES + 5 }, (_, index) => ({
      name: `tool_${index}`,
      description: "x".repeat(40),
      inputSchema: { type: "object", properties: { secretShape: { type: "string" } } },
      route: {
        connectorId: "test",
        resourceId: "big",
        toolName: `tool_${index}`,
        catalogGroup: "huge",
      },
    }));
    const entries = catalogEntries(oversized);
    const result = searchCatalog(entries, { group: "huge" });
    expect(result).toEqual({
      group: "huge",
      count: NAME_INDEX_MAX_NAMES + 5,
      hint: "Pass query to search within this source.",
    });
    expect(JSON.stringify(result)).not.toContain("secretShape");
    expect(JSON.stringify(result)).not.toContain("tool_0");
    const searched = searchCatalog(entries, { group: "huge", query: "tool_0" });
    expect("tools" in searched && searched.tools.map((item) => item.name)).toEqual(["tool_0"]);
  });

  it("returns groups with counts when the name index exceeds budget", () => {
    const oversized = Array.from({ length: NAME_INDEX_MAX_NAMES + 5 }, (_, index) => ({
      name: `tool_${index}`,
      description: "x".repeat(40),
      inputSchema: { type: "object", properties: { secretShape: { type: "string" } } },
      route: {
        connectorId: "test",
        resourceId: `src-${index}`,
        toolName: `tool_${index}`,
        catalogGroup: `group_${Math.floor(index / 50)}`,
      },
    }));
    const entries = catalogEntries(oversized);
    const result = searchCatalog(entries, {});
    expect(result).toMatchObject({
      hint: "Pass group to list names in one source.",
    });
    expect("groups" in result && result.groups.every((item) => item.count > 0)).toBe(true);
    expect("index" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secretShape");
    const [search] = lazyCatalogTools("mcp", "mcp", "MCP", entries);
    expect(search?.description).toContain("Empty query lists sources");
    expect(search?.description).not.toContain("tool_0");
  });

  it("filters query search by group and keeps schema-free hits", () => {
    const catalog = tools(25, "alpha").concat(tools(5, "beta"));
    const first = searchCatalog(catalogEntries(catalog), {
      query: "shared",
      group: "beta",
      limit: 100,
    });
    const second = searchCatalog(catalogEntries(catalog), {
      query: "shared",
      group: "beta",
      limit: 100,
    });

    expect(first).toEqual(second);
    expect("tools" in first && first.tools).toHaveLength(5);
    expect("tools" in first && first.tools.every((item) => item.name.startsWith("tool_"))).toBe(
      true,
    );
    expect(JSON.stringify(first)).not.toContain("secretShape");
  });

  it("caps and stably orders schema-free search results", () => {
    const catalog = tools(25);
    const first = searchCatalog(catalogEntries(catalog), { query: "shared", limit: 100 });
    const second = searchCatalog(catalogEntries(catalog), { query: "shared", limit: 100 });

    expect("tools" in first && first.tools).toHaveLength(TOOL_SEARCH_LIMIT);
    expect(first).toEqual(second);
    expect("tools" in first && first.tools.map((item) => item.name)).toEqual(
      [...(("tools" in first && first.tools.map((item) => item.name)) || [])].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    expect(JSON.stringify(first)).not.toContain("secretShape");
  });

  it("rejects an untrusted selected schema above the byte ceiling", () => {
    const entries = catalogEntries([
      {
        name: "oversized",
        description: "Oversized schema",
        inputSchema: { type: "object", description: "x".repeat(SELECTED_SCHEMA_MAX_BYTES) },
      },
    ]);

    expect(() => loadCatalogEntry(entries, { id: "oversized" })).toThrow("schema is too large");
  });

  it("caps load descriptions like search", () => {
    const long = "d".repeat(600);
    const entries = catalogEntries([
      {
        name: "verbose",
        description: long,
        inputSchema: { type: "object", properties: {} },
        route: { connectorId: "test", resourceId: "src", toolName: "verbose" },
      },
    ]);
    const entry = loadCatalogEntry(entries, { id: "src:verbose" });
    expect(entry.tool.description).toHaveLength(600);
    const hits = searchCatalog(entries, { query: "verbose" });
    expect("tools" in hits && hits.tools[0]?.description).toHaveLength(500);
  });

  it("loads by exposed tool name as well as catalog id", () => {
    const entries = catalogEntries(multiGroupTools());
    expect(loadCatalogEntry(entries, { id: "mcp__gmail__send" }).tool.name).toBe(
      "mcp__gmail__send",
    );
    expect(loadCatalogEntry(entries, { id: "srv-gmail:send" }).tool.name).toBe("mcp__gmail__send");
    expect(loadCatalogEntry(entries, { id: "send" }).tool.name).toBe("mcp__gmail__send");
    expect(() => loadCatalogEntry(entries, { id: "missing" })).toThrow(/unknown/i);
  });

  it("does not execute args when JSON Schema is unsupported", async () => {
    const entries = catalogEntries([
      {
        name: "exotic",
        description: "Unsupported schema",
        // unevaluatedProperties is rejected by z.fromJSONSchema
        inputSchema: {
          type: "object",
          properties: { payload: { type: "string" } },
          unevaluatedProperties: false,
        },
        route: { connectorId: "test", resourceId: "src", toolName: "exotic" },
      },
    ]);

    const executeResolved = vi.fn(async function* () {
      yield { type: "result" as const, data: "executed" };
    });
    const execute = async () => {
      for await (const _event of executeLazyCatalogControl(
        {
          tool: "wrapper",
          args: { id: "src:exotic", arguments: { payload: "raw-bytes", extra: true } },
          executionId: "exec",
          route: { connectorId: "test", toolName: "__catalog_execute" },
        },
        entries,
        executeResolved,
      )) {
        // Consume the catalog execution path.
      }
    };

    await expect(execute()).rejects.toThrow();
    expect(executeResolved).not.toHaveBeenCalled();
  });

  it("still rejects non-object args and unknown ids", () => {
    const entries = catalogEntries(tools(1));
    expect(() =>
      resolveCatalogCall(
        {
          tool: "wrapper",
          args: { id: "missing", arguments: {} },
          executionId: "exec",
          route: { connectorId: "test", toolName: "__catalog_execute" },
        },
        entries,
      ),
    ).toThrow("unknown or not authorized");
    expect(() =>
      resolveCatalogCall(
        {
          tool: "wrapper",
          args: { id: "source-0:tool-0", arguments: ["not-an-object"] },
          executionId: "exec",
          route: { connectorId: "test", toolName: "__catalog_execute" },
        },
        entries,
      ),
    ).toThrow("must be an object");
  });

  it("rejects persisted bound args that no longer match the live schema", () => {
    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    };
    expect(() => assertConnectorToolArgs(schema, { value: "ok" })).not.toThrow();
    expect(() => assertConnectorToolArgs(schema, { value: 1 })).toThrow(/invalid/i);
    expect(() => assertConnectorToolArgs(schema, {})).toThrow(/invalid/i);
  });

  it("rejects schemas that combine patternProperties with additionalProperties false", () => {
    const schema = {
      type: "object",
      patternProperties: { "^x-": { type: "string" } },
      additionalProperties: false,
    };
    expect(() => assertConnectorToolArgs(schema, { "x-a": "ok" })).toThrow(
      /patternProperties with additionalProperties false/,
    );
  });

  it("uniquifies installed tool names across installs", () => {
    expect(uniquifyInstalledToolName("install-A", "delete_item")).toBe(
      "installed__install-A__delete_item",
    );
    expect(uniquifyInstalledToolName("install-B", "delete_item")).toBe(
      "installed__install-B__delete_item",
    );
  });

  it("only prefixes installed names when they collide across installs", () => {
    const tools = disambiguateInstalledToolNames([
      {
        name: "unique_op",
        description: "Only on A",
        inputSchema: { type: "object" },
        route: { connectorId: "installed", resourceId: "install-A", toolName: "unique_op" },
      },
      {
        name: "delete_item",
        description: "On A",
        inputSchema: { type: "object" },
        route: { connectorId: "installed", resourceId: "install-A", toolName: "delete_item" },
      },
      {
        name: "delete_item",
        description: "On B",
        inputSchema: { type: "object" },
        route: { connectorId: "installed", resourceId: "install-B", toolName: "delete_item" },
      },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "unique_op",
      "installed__install-A__delete_item",
      "installed__install-B__delete_item",
    ]);
  });

  it("labels nameless installs with kind and a short id", () => {
    expect(catalogGroupLabel("Gmail", "api", "abcdefghij")).toBe("Gmail");
    expect(catalogGroupLabel("  ", "api", "abcdefghij")).toBe("api-abcdefgh");
    expect(catalogGroupLabel(undefined, "mcp", "xyz")).toBe("mcp-xyz");
  });

  it("formats a compact text index for descriptions", () => {
    expect(
      formatNameIndexText([
        { group: "gmail", names: ["list", "read", "send"] },
        { group: "hubspot", names: ["get_deal", "list_contacts"] },
      ]),
    ).toBe("gmail:\n  list, read, send\nhubspot:\n  get_deal, list_contacts");
  });
});
