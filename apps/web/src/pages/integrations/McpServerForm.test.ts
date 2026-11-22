import type { McpServer } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { mcpServerConfig, mcpServerDraftFor } from "./McpServerForm";

const server = {
  id: "srv_1",
  slug: "docs",
  name: "docs",
  description: "",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test/mcp",
  command: null,
  hasArgs: false,
  envKeys: [],
  fileKeys: [],
  headerKeys: ["X-Api-Key", "X-Team"],
  oauthStatus: "none",
  oauthClientId: null,
  enabled: true,
  verbatimResults: false,
} as unknown as McpServer;
const access = { allBots: true, botIds: [] };

const headersFor = (patch: Partial<ReturnType<typeof mcpServerDraftFor>>) =>
  (
    mcpServerConfig({ ...mcpServerDraftFor(server, access, false), ...patch }, server) as {
      headers: Record<string, string>;
    }
  ).headers;

it("replaces the edited header when it is renamed with a new value", () => {
  expect(headersFor({ headerName: "X-Key", headerValue: "new" })).toEqual({
    "X-Key": "new",
    "X-Team": "",
  });
});

it("drops stored header values when the URL changes", () => {
  expect(headersFor({ endpoint: "https://other.example.test/mcp" })).toEqual({});
});
