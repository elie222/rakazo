import { describe, expect, it } from "vitest";
import { isVerbatimConnectorResult } from "./verbatim-connector-result.js";

describe("verbatim connector results", () => {
  const targets = {
    connectionIds: ["conn-gmail"],
    toolNames: ["custom_direct_tool"],
    catalogMatches: [
      {
        executeToolName: "installed_execute_tool",
        connectionIds: ["conn-gmail"],
        providers: ["gmail"],
      },
    ],
    prefixRules: [
      {
        prefixes: ["gmail_", "github_"],
        excludedPrefixes: ["github_mcp_"],
        batchToolNames: ["BATCH_EXEC"],
        batchItemsKey: "tools",
        batchItemToolKey: "tool_slug",
        batchItemAccountKey: "account",
        allowedAccountsByPrefix: {
          gmail_: ["ca-work"],
        },
      },
    ],
  };

  it("matches routes by connection id, exact tool name, and catalog execute id", () => {
    expect(
      isVerbatimConnectorResult("anything", {}, targets, {
        connectionId: "conn-gmail",
        toolName: "read",
      }),
    ).toBe(true);
    expect(isVerbatimConnectorResult("custom_direct_tool", {}, targets)).toBe(true);
    expect(
      isVerbatimConnectorResult("installed_execute_tool", { id: "conn-gmail:list" }, targets),
    ).toBe(true);
    expect(isVerbatimConnectorResult("installed_execute_tool", { id: "gmail:list" }, targets)).toBe(
      true,
    );
    expect(isVerbatimConnectorResult("installed_execute_tool", { id: "slack:list" }, targets)).toBe(
      false,
    );
    expect(isVerbatimConnectorResult("GMAIL_GET_MESSAGE", {}, undefined)).toBe(false);
  });

  it("matches prefix rules, excludes longer sibling prefixes, and scopes batch accounts", () => {
    expect(isVerbatimConnectorResult("GMAIL_GET_MESSAGE", {}, targets)).toBe(false);
    expect(isVerbatimConnectorResult("GMAIL_GET_MESSAGE", { account: "ca-work" }, targets)).toBe(
      true,
    );
    expect(isVerbatimConnectorResult("GITHUB_GET_REPO", {}, targets)).toBe(true);
    expect(isVerbatimConnectorResult("GITHUB_MCP_SEARCH", {}, targets)).toBe(false);

    expect(
      isVerbatimConnectorResult(
        "BATCH_EXEC",
        {
          tools: [{ tool_slug: "GMAIL_GET_MESSAGE", account: "ca-work" }],
        },
        targets,
      ),
    ).toBe(true);
    expect(
      isVerbatimConnectorResult(
        "BATCH_EXEC",
        {
          tools: [{ tool_slug: "GMAIL_GET_MESSAGE", account: "ca-personal" }],
        },
        targets,
      ),
    ).toBe(false);
    expect(
      isVerbatimConnectorResult(
        "BATCH_EXEC",
        {
          tools: [{ tool_slug: "GITHUB_MCP_SEARCH" }],
        },
        targets,
      ),
    ).toBe(false);
    expect(
      isVerbatimConnectorResult(
        "BATCH_EXEC",
        {
          tools: [{ tool_slug: "GMAIL_GET_MESSAGE" }],
        },
        targets,
      ),
    ).toBe(false);
  });
});
