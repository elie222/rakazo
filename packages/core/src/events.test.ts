import { describe, expect, it } from "vitest";
import {
  appendTextSegment,
  appendToolCallSegment,
  appendToolStep,
  createStreamingRedactor,
  endsSentence,
  humanizeToolName,
  isRunTerminalEvent,
  projectMessages,
  runFailureError,
  trackToolCallStreak,
  trackToolNameStreak,
} from "./events.js";

describe("isRunTerminalEvent", () => {
  it("recognizes every terminal run outcome", () => {
    expect(isRunTerminalEvent({ type: "run.completed" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.failed" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.cancelled" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.waiting_input" })).toBe(false);
  });
});

describe("runFailureError", () => {
  it("returns the error only for run.failed with a real message", () => {
    expect(runFailureError({ type: "run.failed", payload: { error: "provider missing" } })).toBe(
      "provider missing",
    );
    expect(runFailureError({ type: "run.failed", payload: {} })).toBeNull();
    expect(runFailureError({ type: "run.failed", payload: { error: "   " } })).toBeNull();
    expect(runFailureError({ type: "run.failed", payload: { error: 42 } })).toBeNull();
    expect(runFailureError({ type: "run.failed" })).toBeNull();
    expect(runFailureError({ type: "run.completed", payload: { error: "nope" } })).toBeNull();
    expect(runFailureError({ type: "run.cancelled", payload: { error: "nope" } })).toBeNull();
  });

  it("trims surrounding space and clamps a runaway message", () => {
    expect(runFailureError({ type: "run.failed", payload: { error: "  spaced  " } })).toBe(
      "spaced",
    );
    const long = runFailureError({ type: "run.failed", payload: { error: "x".repeat(400) } });
    expect(long).toHaveLength(301);
    expect(long?.endsWith("…")).toBe(true);
  });
});

describe("projectMessages", () => {
  it("replays durable messages and trailing live tokens from progress events", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.message.created",
        payload: { messageId: "m1", role: "user", blocks: [{ kind: "text", text: "hi" }] },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Lis", streaming: true },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "bon", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.blocks[0]).toEqual({ kind: "text", text: "hi" });
    expect(messages[1]?.blocks[0]).toEqual({ kind: "progress", text: "Lisbon" });
  });

  it("drops streaming tokens once the completed message is durable", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Lisbon", streaming: true },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.message.created",
        runId: "r1",
        payload: { messageId: "m2", role: "bot", blocks: [{ kind: "text", text: "Lisbon" }] },
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks[0]).toEqual({ kind: "text", text: "Lisbon" });
  });

  it("keeps live subagent cards until a durable subagent message arrives", () => {
    const live = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.subagent",
        runId: "r1",
        payload: {
          agentId: "a1",
          name: "helper",
          task: "summarize",
          status: "running",
          progress: "working…",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(live).toHaveLength(1);
    expect(live[0]?.blocks[0]).toMatchObject({
      kind: "subagent",
      name: "helper",
      status: "running",
    });

    const durable = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.subagent",
        runId: "r1",
        payload: {
          agentId: "a1",
          name: "helper",
          task: "summarize",
          status: "running",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.message.created",
        runId: "r1",
        payload: {
          messageId: "m1",
          role: "bot",
          blocks: [
            {
              kind: "subagent",
              agentId: "a1",
              name: "helper",
              task: "summarize",
              status: "completed",
              result: "ok",
            },
          ],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(durable).toHaveLength(1);
    expect(durable[0]?.blocks[0]).toMatchObject({ status: "completed", result: "ok" });
  });

  it("drops prior history when a later clear event is replayed", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.message.created",
        payload: { messageId: "m1", role: "user", blocks: [{ kind: "text", text: "old" }] },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "draft" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.cleared",
        payload: {},
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toEqual([]);
  });

  it("collapses repeated tool calls into one step with a count", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks[0]).toEqual({
      kind: "steps",
      steps: [
        { label: "Slack fetch conversation history", count: 2 },
        { label: "Slack find channels", count: 1 },
      ],
    });
  });

  it("holds a tool call that lands mid-sentence until the sentence completes", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Let me check Slack ", streaming: true },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "for a broad search.", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    // The sentence only finishes once "for a broad search." streams in, so the completed
    // sentence and the held-back tool call appear together, in that order.
    expect(messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check Slack for a broad search." },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
  });

  it("keeps a tool call hidden while narration keeps streaming with no sentence end", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Let me check what I have ", streaming: true },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "shell" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "locally and try the GitHub API", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    // No sentence terminator has streamed in yet, so the "Shell" call stays hidden and
    // everything so far renders as one continuous progress tail.
    expect(messages[0]?.blocks).toEqual([
      {
        kind: "progress",
        text: "Let me check what I have locally and try the GitHub API",
        pendingToolNames: ["shell"],
      },
    ]);
  });

  it("keeps interleaved group runs and their tool calls isolated", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        botId: "bot-a",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Alpha " },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        botId: "bot-b",
        seq: 1,
        type: "thread.progress",
        runId: "r2",
        payload: { text: "Beta." },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        botId: "bot-a",
        seq: 2,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "shell" },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      {
        id: "e4",
        threadId: "t1",
        botId: "bot-b",
        seq: 3,
        type: "agent.tool.called",
        runId: "r2",
        payload: { name: "read_file" },
        createdAt: "2026-01-01T00:00:03.000Z",
      },
      {
        id: "e5",
        threadId: "t1",
        botId: "bot-a",
        seq: 4,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "done." },
        createdAt: "2026-01-01T00:00:04.000Z",
      },
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        id: "progress:r1",
        botId: "bot-a",
        blocks: [
          { kind: "text", text: "Alpha done." },
          { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
        ],
      }),
      expect.objectContaining({
        id: "progress:r2",
        botId: "bot-b",
        blocks: [
          { kind: "text", text: "Beta." },
          { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
        ],
      }),
    ]);
  });

  it("clears the live step trail once the run ends", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "run.cancelled",
        runId: "r1",
        payload: {},
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(messages).toHaveLength(0);
  });
});

describe("humanizeToolName", () => {
  it("turns a Composio-style constant into a readable label", () => {
    expect(humanizeToolName("SLACK_FIND_CHANNELS")).toBe("Slack find channels");
  });

  it("turns a lowercase builtin tool name into a readable label", () => {
    expect(humanizeToolName("request_takeover")).toBe("Request takeover");
  });
});

describe("appendToolStep", () => {
  it("starts a new step for the first call", () => {
    expect(appendToolStep([], "SLACK_FIND_CHANNELS")).toEqual([
      { label: "Slack find channels", count: 1 },
    ]);
  });

  it("increments the count when the same tool fires again in a row", () => {
    const first = appendToolStep([], "SLACK_FIND_CHANNELS");
    expect(appendToolStep(first, "SLACK_FIND_CHANNELS")).toEqual([
      { label: "Slack find channels", count: 2 },
    ]);
  });

  it("appends a new step when a different tool fires", () => {
    const first = appendToolStep([], "SLACK_FIND_CHANNELS");
    expect(appendToolStep(first, "SLACK_FETCH_CONVERSATION_HISTORY")).toEqual([
      { label: "Slack find channels", count: 1 },
      { label: "Slack fetch conversation history", count: 1 },
    ]);
  });
});

describe("trackToolCallStreak", () => {
  it("starts a streak of 1 for the first call", () => {
    expect(
      trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", { cursor: "a" }),
    ).toEqual({ key: 'SLACK_FIND_CHANNELS:{"cursor":"a"}', count: 1 });
  });

  it("increments the count when the same tool and args repeat", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(trackToolCallStreak(first, "SLACK_FIND_CHANNELS", { cursor: "a" })).toEqual({
      key: 'SLACK_FIND_CHANNELS:{"cursor":"a"}',
      count: 2,
    });
  });

  it("resets the streak when the same tool is called with different args", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(trackToolCallStreak(first, "SLACK_FIND_CHANNELS", { cursor: "b" })).toEqual({
      key: 'SLACK_FIND_CHANNELS:{"cursor":"b"}',
      count: 1,
    });
  });

  it("resets the streak when a different tool is called", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(trackToolCallStreak(first, "SLACK_FETCH_CONVERSATION_HISTORY", { cursor: "a" })).toEqual(
      { key: 'SLACK_FETCH_CONVERSATION_HISTORY:{"cursor":"a"}', count: 1 },
    );
  });
});

describe("trackToolNameStreak", () => {
  it("starts a streak of 1 for the first call", () => {
    expect(trackToolNameStreak({ name: undefined, count: 0 }, "shell")).toEqual({
      name: "shell",
      count: 1,
    });
  });

  it("increments the count when the same tool name repeats, even with different arguments", () => {
    const first = trackToolNameStreak({ name: undefined, count: 0 }, "shell");
    expect(trackToolNameStreak(first, "shell")).toEqual({ name: "shell", count: 2 });
  });

  it("resets the streak when a different tool is called", () => {
    const first = trackToolNameStreak({ name: undefined, count: 0 }, "shell");
    expect(trackToolNameStreak(first, "recall_memory")).toEqual({
      name: "recall_memory",
      count: 1,
    });
  });
});

describe("endsSentence", () => {
  it("is false mid-clause, with no terminal punctuation", () => {
    expect(endsSentence("Let me check what I have loca")).toBe(false);
  });

  it("is false when the text trails off on whitespace with no punctuation", () => {
    expect(endsSentence("Let me check Slack ")).toBe(false);
  });

  it("is true once the text ends on a sentence terminator", () => {
    expect(endsSentence("Let me check. ")).toBe(true);
    expect(endsSentence("Is that right?")).toBe(true);
    expect(endsSentence('She said "stop!"')).toBe(true);
  });

  it("is true for an empty or whitespace-only string — nothing to protect", () => {
    expect(endsSentence("")).toBe(true);
    expect(endsSentence("   ")).toBe(true);
  });
});

describe("appendTextSegment", () => {
  it("starts a new text segment when there are none", () => {
    expect(appendTextSegment([], "hello")).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("does nothing when the text is empty", () => {
    const segments = [{ kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] }];
    expect(appendTextSegment(segments, "")).toEqual(segments);
  });

  it("merges into the last segment when it is already text", () => {
    const segments = appendTextSegment([], "a");
    expect(appendTextSegment(segments, "b")).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("starts a new text segment after a steps segment", () => {
    const segments = [{ kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] }];
    expect(appendTextSegment(segments, "done")).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
      { kind: "text", text: "done" },
    ]);
  });
});

describe("appendToolCallSegment", () => {
  it("starts a new steps segment when there are none", () => {
    expect(appendToolCallSegment([], "SLACK_FIND_CHANNELS")).toEqual([
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
  });

  it("collapses into the last steps segment for the same tool", () => {
    const segments = appendToolCallSegment([], "SLACK_FIND_CHANNELS");
    expect(appendToolCallSegment(segments, "SLACK_FIND_CHANNELS")).toEqual([
      { kind: "steps", steps: [{ label: "Slack find channels", count: 2 }] },
    ]);
  });

  it("starts a new steps segment after a text segment", () => {
    const segments = [{ kind: "text" as const, text: "hi" }];
    expect(appendToolCallSegment(segments, "shell")).toEqual([
      { kind: "text", text: "hi" },
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
    ]);
  });

  it("adds a new step entry within the same steps segment for a different tool", () => {
    const segments = appendToolCallSegment([], "SLACK_FIND_CHANNELS");
    expect(appendToolCallSegment(segments, "shell")).toEqual([
      {
        kind: "steps",
        steps: [
          { label: "Slack find channels", count: 1 },
          { label: "Shell", count: 1 },
        ],
      },
    ]);
  });
});

describe("createStreamingRedactor", () => {
  it("never emits a secret split across streaming chunks", () => {
    const redactor = createStreamingRedactor(["fake-secret-123"]);
    const output = [
      redactor.push("before fake-se"),
      redactor.push("cret-123 after"),
      redactor.finish(),
    ].join("");
    expect(output).toBe("before [redacted] after");
    expect(output).not.toContain("fake-secret-123");
  });

  it("does not delay chunks when there are no known secrets", () => {
    const redactor = createStreamingRedactor([]);
    expect(redactor.push("hello")).toBe("hello");
    expect(redactor.finish()).toBe("");
  });
});
