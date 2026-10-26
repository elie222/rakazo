import { describe, expect, it } from "vitest";
import { mcpApprovalAsk, wakeIsDue } from "./runner.js";

const now = Date.parse("2026-10-25T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

describe("forcing a routine wake", () => {
  it("wakes a routine due within the horizon", () => {
    expect(wakeIsDue(new Date(now + day), now, 3 * day)).toBe(true);
    expect(wakeIsDue(new Date(now - 1000), now, 3 * day)).toBe(true);
  });

  it("leaves a routine started later than the horizon alone", () => {
    expect(wakeIsDue(new Date(now + 8 * day), now, 3 * day)).toBe(false);
  });

  it("never wakes a routine with no next run, and always wakes without a horizon", () => {
    expect(wakeIsDue(null, now, 3 * day)).toBe(false);
    expect(wakeIsDue(new Date(now + 30 * day), now)).toBe(true);
  });
});

describe("an MCP approval card", () => {
  const block = {
    kind: "mcp_approval" as const,
    name: "Tasklog",
    serverId: "server",
    transport: "streamable_http" as const,
    endpoint: "http://127.0.0.1:41234/mcp",
    needsOAuth: false,
    status: "pending" as const,
  };

  it("shows the person the server, its address and the web card's buttons", () => {
    expect(mcpApprovalAsk(block)).toEqual({
      text: "Connect MCP server “Tasklog”",
      detail: "http://127.0.0.1:41234/mcp",
      actions: [
        { id: "approve", label: "Approve" },
        { id: "dismiss", label: "Not now" },
      ],
    });
  });

  it("labels an OAuth card Authorize, as the web does", () => {
    expect(mcpApprovalAsk({ ...block, needsOAuth: true }).actions?.[0]).toEqual({
      id: "approve",
      label: "Authorize",
    });
  });
});
