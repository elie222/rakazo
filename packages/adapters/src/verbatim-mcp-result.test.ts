import { describe, expect, it } from "vitest";
import { isVerbatimMcpResult, verbatimMcpServerSet } from "./verbatim-mcp-result.js";

const servers = verbatimMcpServerSet([
  { id: "srv_mail", slug: "mail", verbatimResults: true },
  { id: "srv_docs", slug: "docs", verbatimResults: false },
]);

describe("verbatim MCP results", () => {
  it("keeps only servers that asked for whole results", () => {
    expect(servers).toEqual({ ids: ["srv_mail"], slugs: ["mail"] });
    expect(verbatimMcpServerSet([{ id: "srv_docs", slug: "docs" }])).toBeUndefined();
  });

  it("matches a direct MCP tool by server slug and a catalog call by server id", () => {
    expect(isVerbatimMcpResult("mcp__mail__get_message", {}, servers)).toBe(true);
    expect(isVerbatimMcpResult("mcp__docs__search", {}, servers)).toBe(false);
    expect(
      isVerbatimMcpResult("connectors_execute_tool", { id: "srv_mail:get_message" }, servers),
    ).toBe(true);
    expect(isVerbatimMcpResult("connectors_execute_tool", { id: "srv_docs:search" }, servers)).toBe(
      false,
    );
    expect(
      isVerbatimMcpResult("installed_execute_tool", { id: "srv_mail:get_message" }, servers),
    ).toBe(false);
    expect(isVerbatimMcpResult("mcp__mail__get_message", {}, undefined)).toBe(false);
  });
});
