import { describe, expect, it } from "vitest";
import {
  connectorToolPermissionNeeded,
  denyConnectorToolMessage,
} from "./global-bot-connectors.js";
import type { RunContext } from "./run-context.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";

function request(name: string, options: { readOnly?: boolean } = {}): ToolRequest {
  return {
    name,
    args: {},
    executionId: "exec-1",
    connectorCall: {
      tool: name,
      args: {},
      executionId: "exec-1",
      route: {
        connectorId: "mcp",
        resourceId: "server-1",
        toolName: name.split("__").pop() ?? name,
      },
    },
    effectRequest: {},
    resolvedTool: {
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      readOnly: options.readOnly,
      route: { connectorId: "mcp", resourceId: "server-1", toolName: name },
    },
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: name,
    fleetSummary: undefined,
  };
}

function globalBotCtx(permissions: ReadonlySet<"finance.read" | "finance.write">): RunContext {
  return {
    globalBot: { globalBotId: "g1", role: "member", permissions },
    tools: {
      connector: new Map(),
      connectedPlugins: [],
      approvedReplays: { peek: () => undefined, take: () => undefined },
    },
    run: { trigger: "user", id: "run-1", userId: "u1", spaceId: "s1" },
    runId: "run-1",
    deps: {},
    trust: {},
    source: { ownerStartedRun: true },
  } as unknown as RunContext;
}

describe("gateToolCall Global bot permissions", () => {
  it("denies mutating connector tools without finance.write", async () => {
    const result = await gateToolCall(
      globalBotCtx(new Set(["finance.read"])),
      request("mcp__books__create_transfer", { readOnly: false }),
      undefined,
    );
    expect(result).toEqual({
      result: {
        error: denyConnectorToolMessage("mcp__books__create_transfer", "finance.write"),
      },
    });
  });

  it("denies read connector tools without finance.read", async () => {
    const result = await gateToolCall(
      globalBotCtx(new Set()),
      request("mcp__books__list_accounts", { readOnly: true }),
      undefined,
    );
    expect(result).toEqual({
      result: {
        error: denyConnectorToolMessage("mcp__books__list_accounts", "finance.read"),
      },
    });
  });

  it("maps allow decisions for member vs owner before approval runs", () => {
    expect(connectorToolPermissionNeeded("mcp__books__list_accounts", true)).toBe("finance.read");
    expect(connectorToolPermissionNeeded("mcp__books__create_transfer", false)).toBe(
      "finance.write",
    );
    const member = new Set(["finance.read"]);
    const owner = new Set(["finance.read", "finance.write"]);
    expect(member.has(connectorToolPermissionNeeded("mcp__books__list_accounts", true))).toBe(
      true,
    );
    expect(member.has(connectorToolPermissionNeeded("mcp__books__create_transfer", false))).toBe(
      false,
    );
    expect(owner.has(connectorToolPermissionNeeded("mcp__books__create_transfer", false))).toBe(
      true,
    );
  });
});
