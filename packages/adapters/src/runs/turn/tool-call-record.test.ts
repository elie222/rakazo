import { TOOL_CALL_ARGUMENTS_MAX_CHARS, TOOL_CALL_RESULT_HEAD_MAX_CHARS } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { historyToolCalls, recordToolCall, toolCallTrace } from "./tool-call-record.js";

const SECRET = "sk-live-abcdef";

function completion(overrides: Record<string, unknown> = {}) {
  return {
    name: "mail_execute",
    executionId: "exec-1",
    durationMs: 1200,
    arguments: { query: "in:inbox", apiKey: SECRET },
    result: { content: [{ type: "text", text: "two messages" }] },
    ...overrides,
  } as Parameters<typeof toolCallTrace>[0];
}

describe("toolCallTrace", () => {
  it("redacts the run's secrets from the arguments before anything is stored", () => {
    const trace = toolCallTrace(completion(), [SECRET]);
    expect(trace.arguments).not.toContain(SECRET);
    expect(trace.arguments).toContain("in:inbox");
  });

  it("caps long arguments and long error text", () => {
    const trace = toolCallTrace(
      completion({
        arguments: { body: "x".repeat(TOOL_CALL_ARGUMENTS_MAX_CHARS * 2) },
        error: new Error("y".repeat(5_000)),
      }),
      [],
    );
    expect(trace.arguments?.length ?? 0).toBeLessThanOrEqual(TOOL_CALL_ARGUMENTS_MAX_CHARS + 80);
    expect(trace.error?.length ?? 0).toBeLessThanOrEqual(1_000 + 80);
    expect(trace.outcome).toBe("failed");
  });

  it("keeps the size of a result and says when it was shortened", () => {
    const trace = toolCallTrace(
      completion({ result: { content: [{ type: "text", text: "z".repeat(4_000) }] } }),
      [],
    );
    expect(trace.resultBytes).toBe(4_000);
    expect(trace.resultShortened).toBeUndefined();
  });

  it("keeps a shortened result's size from before the cut, not the size that was kept", () => {
    const trace = toolCallTrace(
      completion({
        result: { content: [{ type: "text", text: "z".repeat(4_000) }] },
        resultShortened: true,
        resultBytes: 184_320,
      }),
      [],
    );
    expect(trace.resultBytes).toBe(184_320);
    expect(trace.resultShortened).toBe(true);
  });

  it("keeps a short head only of a failed result, the one place it is shown", () => {
    const failed = toolCallTrace(
      completion({
        result: { content: [{ type: "text", text: "z".repeat(4_000) }] },
        error: new Error("401 Unauthorized"),
      }),
      [],
    );
    expect(failed.outcome).toBe("failed");
    expect(failed.resultHead?.length ?? 0).toBeGreaterThan(0);
    expect(failed.resultHead?.length ?? 0).toBeLessThanOrEqual(
      TOOL_CALL_RESULT_HEAD_MAX_CHARS + 80,
    );
    // A call that worked, shortened or not, keeps none: nothing would ever show it.
    const worked = toolCallTrace(completion({ resultShortened: true }), []);
    expect(worked.outcome).toBe("succeeded");
    expect(worked.resultHead).toBeUndefined();
  });

  it("keeps no head of a tool that returns secrets, but still says how much came back", () => {
    const trace = toolCallTrace(
      completion({ name: "vault_secret_read", resultShortened: true }),
      [],
    );
    expect(trace.resultHead).toBeUndefined();
    expect(trace.resultBytes).toBe(12);
    expect(trace.resultShortened).toBe(true);
  });

  it("keeps no error of a tool that returns secrets, thrown or returned, but still says it failed", () => {
    const thrown = toolCallTrace(
      completion({ name: "vault_secret_read", error: new Error("secret DEPLOY_TOKEN not found") }),
      [],
    );
    expect(thrown.outcome).toBe("failed");
    expect(thrown.error).toBeUndefined();
    expect(thrown.resultHead).toBeUndefined();
    const returned = toolCallTrace(
      completion({
        name: "vault_secret_read",
        result: {
          content: [{ type: "text", text: "secret DEPLOY_TOKEN not found" }],
          isError: true,
        },
      }),
      [],
    );
    expect(returned.error).toBeUndefined();
    expect(returned.resultHead).toBeUndefined();
  });

  it("marks a call that paused while waiting on the person", () => {
    expect(toolCallTrace(completion({ paused: true }), []).outcome).toBe("paused");
  });
});

describe("recordToolCall", () => {
  const target = { spaceId: "space", threadId: "thread", botId: "bot", runId: "run" };
  // The write checks its run is still live in the same transaction, then creates the row.
  const database = (create: unknown) =>
    ({
      $transaction: (work: (tx: unknown) => Promise<unknown>) =>
        work({
          $queryRaw: async () => [{ status: "running" }],
          toolCallRecord: { create },
        }),
    }) as never;

  it("stores nothing when the Space does not keep records", async () => {
    const create = vi.fn();
    await recordToolCall(database(create), false, target, completion(), []);
    expect(create).not.toHaveBeenCalled();
  });

  it("stores a redacted trace when the Space keeps them", async () => {
    const create = vi.fn(async (stored: { data: Record<string, unknown> }) => stored);
    await recordToolCall(database(create), true, target, completion(), [SECRET]);
    const stored = create.mock.calls[0]?.[0];
    expect(stored?.data.runId).toBe("run");
    expect(String(stored?.data.arguments)).not.toContain(SECRET);
  });

  it("never fails the run when the write fails", async () => {
    const create = vi.fn(async () => {
      throw new Error("database is down");
    });
    await expect(
      recordToolCall(database(create), true, target, completion(), []),
    ).resolves.toBeUndefined();
  });
});

describe("historyToolCalls", () => {
  it("bounds what a bot reads and drops the result head of a call that worked", () => {
    const [kept, failed] = historyToolCalls(
      [
        {
          executionId: "a",
          tool: "mail_execute",
          durationMs: 5,
          outcome: "succeeded",
          resultHead: "ok",
          arguments: "{}",
        },
        {
          executionId: "b",
          tool: "mail_execute",
          durationMs: 9,
          outcome: "failed",
          resultHead: "denied",
          error: "401",
          arguments: "{}",
        },
      ],
      [],
    );
    expect(kept).not.toHaveProperty("resultHead");
    expect(failed).toMatchObject({ outcome: "failed", error: "401", resultHead: "denied" });
  });
});
