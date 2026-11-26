import type {
  AdapterContext,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
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

describe("connector catalog source", () => {
  const calendar: ConnectorTool = {
    name: "mcp__workbench__get_release_calendar",
    description: "Read the team's release calendar.",
    inputSchema: { type: "object", properties: { week: { type: "string" } } },
    route: { connectorId: "mcp", resourceId: "server-1", toolName: "get_release_calendar" },
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

  it("reports a catalog that fails instead of finding nothing in it", async () => {
    const failing = connectorCatalogSource(
      {
        async *execute() {
          yield { type: "error" as const, message: "Server unavailable" };
        },
      },
      context,
      lazyCatalogTools("connectors", "mcp", "MCP", entries),
      "run-1",
    );
    await expect(failing.search("release calendar", 5)).rejects.toThrow("Server unavailable");
  });
});
