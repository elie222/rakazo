import { expect, it } from "vitest";
import { MAX_GROUP_LENGTH } from "../tools/lazy-tool-catalog.tool-definition.js";
import { mcpCatalogGroup, unavailableTool } from "./mcp-connector.tool-definition.js";

const server = { id: "server-1", name: "Mail", slug: "mail", revision: 3 };

it("stands in for a server whose tools could not be listed, with the reason", () => {
  expect(unavailableTool(server, "auth failed")).toEqual({
    name: "mcp__mail__unavailable",
    description:
      'The MCP server "Mail" is assigned to you but is unavailable right now, so none of its tools can be used. Reason: auth failed. Tell the user it failed to start rather than saying it is not assigned. Calling this tool returns the same error.',
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    route: {
      connectorId: "mcp",
      resourceId: "server-1",
      resourceRevision: 3,
      toolName: "__rakazo_unavailable",
      catalogGroup: "Mail",
    },
  });
});

it("labels the catalog source with the server name, not an opaque slug", () => {
  expect(mcpCatalogGroup({ name: "Docs", slug: "integration-aaa231a9" })).toBe("Docs");
  expect(mcpCatalogGroup({ name: "Mail", slug: "mail" })).toBe("Mail");
  expect(mcpCatalogGroup({ name: "  ", slug: "demo" })).toBe("demo");
  expect(mcpCatalogGroup({ name: "n".repeat(MAX_GROUP_LENGTH + 5), slug: "demo" })).toBe(
    "n".repeat(MAX_GROUP_LENGTH),
  );
});

it("cuts a long reason", () => {
  expect(unavailableTool(server, "x".repeat(401)).description).toContain(
    `Reason: ${"x".repeat(400)}.... Tell the user`,
  );
});
