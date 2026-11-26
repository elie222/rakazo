import type {
  AdapterContext,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { selectBuiltinToolsForRun } from "../../runs/tools/run-tool-selection.js";
import { findTools, partitionTools } from "../builtin-tool-bridge.js";
import {
  catalogEntries,
  executeLazyCatalogControl,
  lazyCatalogTools,
} from "../lazy-tool-catalog.js";
import { appCatalogSource } from "./app-catalog-source.js";
import { connectorCatalogSource } from "./connector-catalog-source.js";

const context = { signal: new AbortController().signal } as AdapterContext;

const app = (name: string, connected = false): ConnectorCatalogItem => ({
  connectorId: "apps",
  slug: name.toUpperCase().replaceAll(" ", "_"),
  name,
  logo: null,
  connected,
  noAuth: false,
});

const catalogOf = (items: ConnectorCatalogItem[]) =>
  appCatalogSource(
    [
      {
        describe: () => ({ id: "apps" }),
        catalog: async () => items,
      } as never as ManagedConnectorProvider,
    ],
    context,
  );

describe("find_tool", () => {
  it("names an app that is only in the catalog, with connect_app as its next step", async () => {
    const { deferred } = partitionTools(
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: true,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
      }),
    );
    const apps = catalogOf([app("Pagesnap"), app("Gmail", true)]);
    const { result } = await findTools(
      {
        deferred,
        search: (request) =>
          "ids" in request ? apps.find(request.ids) : apps.search(request.query, request.limit),
      },
      { query: "pagesnap screenshot of a web page" },
    );
    expect(result.tools).toContainEqual({
      next: "connect_app",
      app: "PAGESNAP",
      title: "Pagesnap",
      description: "An app the user can connect.",
    });
  });
});

describe("find_tool by name", () => {
  it("finds an app by the slug written in any case, without calling it unknown", async () => {
    const apps = catalogOf([app("Google Sheets")]);
    const { result } = await findTools(
      { deferred: [], search: (request) => apps.find("ids" in request ? request.ids : []) },
      { names: ["google_sheets"] },
    );
    expect(result).toEqual({
      tools: [
        {
          next: "connect_app",
          app: "GOOGLE_SHEETS",
          title: "Google Sheets",
          description: "An app the user can connect.",
        },
      ],
    });
  });
});

describe("app catalog source", () => {
  const apps = catalogOf([
    app("Pagesnap"),
    app("Userback"),
    app("Box"),
    app("Microsoft To Do"),
    app("Monday.com"),
    app("Google Sheets"),
    app("Google Calendar", true),
  ]);

  it("finds the app a request names, and not ones that only share a short word or a substring", async () => {
    const found = await apps.search("use the pagesnap tool on my inbox", 5);
    expect(found.map((hit) => hit.name)).toEqual(["Pagesnap"]);
  });

  it("does not offer an app whose name is only part of a word the request uses", async () => {
    expect(await apps.search("use the pagesnapper tool", 5)).toEqual([]);
  });

  it("finds an app whose whole name is a short word", async () => {
    expect((await apps.search("put it in box for me", 5)).map((hit) => hit.name)).toEqual(["Box"]);
  });

  it("ranks the app named in full above one sharing a word of its name", async () => {
    const found = await apps.search("add to my google calendar", 5);
    expect(found.map((hit) => [hit.name, hit.description])).toEqual([
      ["Google Calendar", "Connected."],
      ["Google Sheets", "An app the user can connect."],
    ]);
  });

  it("finds an app by the id or name find_tool showed", async () => {
    expect((await apps.find(["pagesnap", "google sheets"])).map((hit) => hit.id)).toEqual([
      "PAGESNAP",
      "GOOGLE_SHEETS",
    ]);
  });
});

describe("app catalog source with an app two catalogs list", () => {
  it("finds the slug only one of them uses", async () => {
    const apps = catalogOf([app("Pagesnap"), { ...app("Pagesnap"), slug: "pagesnap_v2" }]);
    expect((await apps.find(["pagesnap_v2"])).map((hit) => hit.id)).toEqual(["pagesnap_v2"]);
  });
});

describe("connector catalog source", () => {
  const calendar: ConnectorTool = {
    name: "mcp__workbench__get_release_calendar",
    description: "Read the team's release calendar.",
    inputSchema: { type: "object", properties: { week: { type: "string" } } },
    route: {
      connectorId: "mcp",
      resourceId: "server-1",
      toolName: "get_release_calendar",
      catalogGroup: "Workbench",
    },
  };
  const entries = catalogEntries([
    calendar,
    {
      ...calendar,
      name: "mcp__workbench__list_boards",
      description: "List boards.",
      route: { ...calendar.route!, toolName: "list_boards" },
    },
  ]);
  const connector = {
    execute: (call: ConnectorCall) =>
      executeLazyCatalogControl(call, entries, async function* () {}),
  };
  const source = connectorCatalogSource(
    connector,
    context,
    lazyCatalogTools("connectors", "mcp", "MCP", entries),
    "run-1",
  );

  it("finds a held-back tool with its parameters and the connector that runs it", async () => {
    expect(await source.search("release calendar", 5)).toEqual([
      {
        id: "server-1:get_release_calendar",
        name: calendar.name,
        description: calendar.description,
        next: "use_tool",
        inputSchema: calendar.inputSchema,
        connectorId: "mcp",
      },
    ]);
    expect((await source.find(["server-1:get_release_calendar"])).map((hit) => hit.id)).toEqual([
      "server-1:get_release_calendar",
    ]);
  });

  it("finds a source's tools by the source's name", async () => {
    expect((await source.search("Workbench", 5)).map((hit) => hit.name)).toEqual([
      calendar.name,
      "mcp__workbench__list_boards",
    ]);
  });

  it("loads one catalog for all the schemas in a query", async () => {
    const execute = vi.fn(connector.execute);
    const source = connectorCatalogSource(
      { execute },
      context,
      lazyCatalogTools("connectors", "mcp", "MCP", entries),
      "run-1",
    );
    const hits = await source.search("Workbench", 5);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(hits.map(({ id, inputSchema }) => [id, inputSchema])).toEqual(
      entries.map(({ id, tool }) => [id, tool.inputSchema]),
    );
  });

  it("hides only the tools of a connector whose catalog fails", async () => {
    const source = connectorCatalogSource(
      {
        execute: (call: ConnectorCall) =>
          call.route?.connectorId === "installed"
            ? (async function* () {
                yield { type: "error" as const, message: "Server unavailable" };
              })()
            : executeLazyCatalogControl(call, entries, async function* () {}),
      },
      context,
      [
        ...lazyCatalogTools("connectors", "mcp", "MCP", entries),
        ...lazyCatalogTools("installed", "installed", "API", entries),
      ],
      "run-1",
    );
    expect((await source.search("release calendar", 5)).map((hit) => hit.connectorId)).toEqual([
      "mcp",
    ]);
  });
});
