import { expect, it } from "vitest";
import { unavailableTool } from "./mcp-connector.tool-definition.js";

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
      catalogGroup: "mail",
    },
  });
});

it("cuts a long reason", () => {
  expect(unavailableTool(server, "x".repeat(401)).description).toContain(
    `Reason: ${"x".repeat(400)}.... Tell the user`,
  );
});
