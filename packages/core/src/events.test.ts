import { describe, expect, it } from "vitest";
import {
  appendTextSegment,
  appendToolCallSegment,
  appendToolStep,
  createStreamingRedactor,
  humanizeToolName,
  projectMessages,
  splitFlushableText,
  trackToolCallStreak,
  trackToolNameStreak,
} from "./events.js";

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

  it("merges narration and tool calls into one live message in chronological order", () => {
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
        payload: { delta: "Found it, now sanding", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check Slack " },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
      { kind: "progress", text: "Found it, now sanding" },
    ]);
  });

  it("holds back a partial trailing word across a tool call instead of splitting it", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Let me check what I have loca", streaming: true },
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
        payload: { delta: "lly and try the GitHub API.", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check what I have " },
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
      { kind: "progress", text: "locally and try the GitHub API." },
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

describe("splitFlushableText", () => {
  it("flushes everything up to and including the last whitespace", () => {
    expect(splitFlushableText("Let me check what I have loca")).toEqual({
      flush: "Let me check what I have ",
      carry: "loca",
    });
  });

  it("holds back the whole string when there is no whitespace at all", () => {
    expect(splitFlushableText("loca")).toEqual({ flush: "", carry: "loca" });
  });

  it("flushes everything and carries nothing when the text ends on whitespace", () => {
    expect(splitFlushableText("Let me check. ")).toEqual({
      flush: "Let me check. ",
      carry: "",
    });
  });

  it("flushes everything and carries nothing for an empty string", () => {
    expect(splitFlushableText("")).toEqual({ flush: "", carry: "" });
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
