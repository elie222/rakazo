import { describe, expect, it } from "vitest";
import { judgeFlow, mcpApprovalAsk, mcpCardRequest, mcpPendingCard, wakeIsDue } from "./runner.js";

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

describe("answering an MCP approval card", () => {
  const pending = {
    kind: "mcp_approval" as const,
    name: "Tasklog",
    serverId: "server",
    transport: "streamable_http" as const,
    endpoint: "http://127.0.0.1:41234/mcp",
    needsOAuth: false,
    status: "pending" as const,
  };

  it("offers only a pending card, with its server and chat", () => {
    expect(mcpPendingCard("thread", pending)).toMatchObject({
      kind: "mcp",
      threadId: "thread",
      serverId: "server",
      needsOAuth: false,
    });
    expect(mcpPendingCard("thread", { ...pending, status: "connected" })).toBeUndefined();
    expect(mcpPendingCard("thread", { ...pending, status: "dismissed" })).toBeUndefined();
    expect(mcpPendingCard("thread", { kind: "text", text: "hi" })).toBeUndefined();
  });

  it("makes the web card's call for each button", () => {
    const card = { serverId: "server", threadId: "thread", needsOAuth: false };
    expect(mcpCardRequest(card, "approve", "bot")).toEqual({
      procedure: "mcp/assignments/approve",
      body: { botId: "bot", serverId: "server", threadId: "thread" },
    });
    expect(mcpCardRequest(card, "dismiss", "bot")).toEqual({
      procedure: "mcp/assignments/dismiss",
      body: { botId: "bot", serverId: "server", threadId: "thread" },
    });
  });

  it("has no call for Authorize on an OAuth card, but can still dismiss it", () => {
    const card = { serverId: "server", threadId: "thread", needsOAuth: true };
    expect(mcpCardRequest(card, "approve", "bot")).toBeUndefined();
    expect(mcpCardRequest(card, "dismiss", "bot")?.procedure).toBe("mcp/assignments/dismiss");
  });
});

describe("judging a flow", () => {
  const labels = [
    { input: { rubric: "r", evidence: "honest" }, pass: true },
    { input: { rubric: "r", evidence: "invented" }, pass: false },
  ];
  const run = { rubric: "r", evidence: "run" };

  it("judges the run once the judge agrees with every label", async () => {
    const seen: unknown[] = [];
    const judge = async ({ evidence }: { evidence: unknown }) => {
      seen.push(evidence);
      return { pass: evidence !== "invented", reason: `judged ${String(evidence)}` };
    };
    await expect(judgeFlow(judge, run, labels)).resolves.toEqual({
      pass: true,
      reason: "judged run",
    });
    expect(seen).toEqual(["honest", "invented", "run"]);
  });

  it("fails without judging the run when the judge disagrees with a label", async () => {
    const seen: unknown[] = [];
    const judge = async ({ evidence }: { evidence: unknown }) => {
      seen.push(evidence);
      return { pass: true, reason: "looks fine" };
    };
    await expect(judgeFlow(judge, run, labels)).resolves.toEqual({
      pass: false,
      reason: "Judge unavailable: judge disagreed with calibration label 2: looks fine",
    });
    expect(seen).toEqual(["honest", "invented"]);
  });

  it("fails when the judge errors, as when the spend cap stops it", async () => {
    const judge = async () => {
      throw new Error("spend-cap");
    };
    await expect(judgeFlow(judge, run, [])).resolves.toEqual({
      pass: false,
      reason: "Judge unavailable: spend-cap",
    });
  });
});
