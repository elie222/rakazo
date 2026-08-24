import type {
  ComputerStatus,
  ProductEvent,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  activeThreadRuns,
  computerPanelAutoBoot,
  isThreadSnapshotEvent,
  mergeThreadSnapshot,
  prependThreadMessagePage,
  reduceComputerStatus,
  reduceThreadSnapshot,
  userHoldsComputerControl,
} from "./thread-events.js";

describe("thread event reduction", () => {
  it("prepends older pages in order, removes overlaps, and advances the history cursor", () => {
    const initial = snapshot([message("m-2", [], 2), message("m-3", [], 3)], 2);

    const next = prependThreadMessagePage(initial, {
      threadId: "thread-1",
      messages: [message("m-0", [], 0), message("m-1", [], 1), message("m-2", [], 2)],
      olderCursor: null,
    });

    expect(next?.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2", "m-3"]);
    expect(next?.olderCursor).toBeNull();
  });

  it("ignores a stale older page after the conversation was cleared", () => {
    const cleared = snapshot([], null);
    const next = prependThreadMessagePage(cleared, {
      threadId: "thread-1",
      messages: [message("old-1", [], 0), message("old-2", [], 1)],
      olderCursor: null,
    });
    expect(next).toBe(cleared);
  });

  it("merges a refreshed recent page with loaded history and drops stale live messages", () => {
    const previous = snapshot(
      [
        message("m-0", [], 0),
        message("m-1", [], 1),
        message("progress:run-1", [{ kind: "progress", text: "draft" }], 9),
      ],
      null,
    );
    const recent = snapshot([message("m-1", [], 1), message("m-2", [], 2)], 1);

    const next = mergeThreadSnapshot(previous, recent, true);

    expect(next.messages.map((item) => item.id)).toEqual(["m-0", "m-1", "m-2"]);
    expect(next.olderCursor).toBeNull();
  });

  it("accumulates progress deltas and keeps only the active progress message", () => {
    const stale = message("progress:older", [{ kind: "progress", text: "old run" }]);
    const initial = snapshot([stale]);

    const first = reduceThreadSnapshot(
      initial,
      event({ type: "thread.progress", seq: 4, runId: "run-1", payload: { delta: "Hel" } }),
    );
    const second = reduceThreadSnapshot(
      first,
      event({ type: "thread.progress", seq: 5, runId: "run-1", payload: { delta: "lo" } }),
    );

    expect(second?.cursor).toBe(5);
    expect(second?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [{ kind: "progress", text: "Hello" }],
      }),
    ]);
  });

  it("updates a live subagent in place while preserving streamed answer progress", () => {
    const activeRun = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([
        message("subagent:research", [
          {
            kind: "subagent",
            agentId: "research",
            name: "Research",
            task: "Find sources",
            status: "running",
            progress: "Starting",
          },
        ]),
        {
          ...message("progress:run-1", [{ kind: "progress", text: "Draft" }]),
          runId: activeRun.id,
        },
      ]),
      run: activeRun,
      activeRuns: undefined,
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.subagent",
        seq: 8,
        payload: {
          agentId: "research",
          name: "Research",
          task: "Find sources",
          status: "completed",
          result: "Three sources found",
        },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["subagent:research", "progress:run-1"]);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({
      kind: "subagent",
      status: "completed",
      result: "Three sources found",
    });
  });

  it("replaces transient progress and a matching live subagent with the durable message", () => {
    const initial = snapshot([
      message("durable", [{ kind: "text", text: "old value" }]),
      message("subagent:research", [
        {
          kind: "subagent",
          agentId: "research",
          name: "Research",
          task: "Find sources",
          status: "running",
        },
      ]),
      message("subagent:other", [
        {
          kind: "subagent",
          agentId: "other",
          name: "Other",
          task: "Keep working",
          status: "running",
        },
      ]),
      message("progress:run-1", [{ kind: "progress", text: "Draft" }]),
    ]);
    const completedBlock = {
      kind: "subagent" as const,
      agentId: "research",
      name: "Research",
      task: "Find sources",
      status: "completed" as const,
      result: "Done",
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        id: "event-message",
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "durable", role: "bot", blocks: [completedBlock] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["subagent:other", "durable"]);
    expect(next?.messages[1]?.blocks).toEqual([completedBlock]);
  });

  it("clears durable and transient history when another client clears the thread", () => {
    const initial = snapshot(
      [
        message("message-1", [{ kind: "text", text: "old" }]),
        message("progress:run-1", [{ kind: "progress", text: "draft" }]),
      ],
      1,
    );
    initial.run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
    };

    const next = reduceThreadSnapshot(
      initial,
      event({ type: "thread.cleared", seq: 12, runId: undefined }),
    );

    expect(next).toMatchObject({ cursor: 12, messages: [], olderCursor: null, run: null });
  });

  it("routes clear and terminal events through the snapshot reducer", () => {
    expect(
      isThreadSnapshotEvent(event({ type: "thread.cleared", seq: 12, runId: undefined })),
    ).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "run.started" }))).toBe(true);
    expect(isThreadSnapshotEvent(event({ type: "run.completed" }))).toBe(true);
  });

  it("keeps group member status in sync with run lifecycle events", () => {
    const run = threadRun("run-1", "bot-member");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      botId: undefined,
      groupId: "group-1",
      members: [{ botId: "bot-member", name: "Member", color: "#8B5CF6", status: "idle" }],
    };

    const started = reduceThreadSnapshot(
      initial,
      event({ type: "run.started", botId: "bot-member", runId: run.id }),
    );
    expect(started?.members?.[0]?.status).toBe("running");

    const waiting = reduceThreadSnapshot(
      { ...started!, run, activeRuns: [run] },
      event({
        type: "run.waiting_input",
        seq: 5,
        botId: "bot-member",
        runId: run.id,
      }),
    );
    expect(waiting?.members?.[0]?.status).toBe("waiting_input");

    const completed = reduceThreadSnapshot(
      waiting,
      event({ type: "run.completed", seq: 6, botId: "bot-member", runId: run.id }),
    );
    expect(completed?.members?.[0]?.status).toBe("idle");
  });

  it("clears only the terminal run's live progress", () => {
    const runA = threadRun("run-a", "bot-a");
    const runB = threadRun("run-b", "bot-b");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-a", [{ kind: "progress", text: "A" }]),
          runId: runA.id,
        },
        {
          ...message("progress:run-b", [{ kind: "progress", text: "B" }]),
          runId: runB.id,
        },
      ]),
      run: runA,
      activeRuns: [runA, runB],
    };
    const failed = event({ type: "run.failed", seq: 10, runId: runA.id });

    const next = reduceThreadSnapshot(initial, failed);

    expect(isThreadSnapshotEvent(failed)).toBe(true);
    expect(next?.messages.map((item) => item.id)).toEqual(["progress:run-b"]);
    expect(next?.run).toEqual(runB);
    expect(next?.activeRuns).toEqual([runB]);
    expect(next?.cursor).toBe(10);
  });

  it("applies the durable waiting-input run transition without a refresh", () => {
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: {
        id: "run-1",
        botId: "bot-1",
        threadId: "thread-1",
        taskId: "task-1",
        status: "running",
        trigger: "user",
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: null,
        completedAt: null,
      },
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: "run-1" }),
    );

    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.cursor).toBe(6);
    expect(
      reduceThreadSnapshot(waiting, event({ type: "run.waiting_input", seq: 7, runId: "run-1" })),
    ).toBe(waiting);
  });

  it("accumulates tool-call steps and collapses repeats into a count", () => {
    const initial = snapshot([]);

    const first = reduceThreadSnapshot(
      initial,
      event({
        type: "agent.tool.called",
        seq: 4,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );
    const second = reduceThreadSnapshot(
      first,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
      }),
    );
    const third = reduceThreadSnapshot(
      second,
      event({
        type: "agent.tool.called",
        seq: 6,
        runId: "run-1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
      }),
    );

    expect(third?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "steps",
            steps: [
              { label: "Slack find channels", count: 1 },
              { label: "Slack fetch conversation history", count: 2 },
            ],
          },
        ],
      }),
    ]);
  });

  it("holds a tool call that lands mid-sentence until the sentence completes", () => {
    const initial = snapshot([]);

    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check Slack ", streaming: true },
      }),
    );
    const afterTool = reduceThreadSnapshot(
      afterNarration,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );

    // Still mid-sentence — the tool call stays hidden, folded into the streaming text instead.
    expect(afterTool?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "progress",
            text: "Let me check Slack ",
            pendingToolNames: ["SLACK_FIND_CHANNELS"],
          },
        ],
      }),
    ]);

    const afterMore = reduceThreadSnapshot(
      afterTool,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "for a broad search.", streaming: true },
      }),
    );

    // The sentence just finished — the completed sentence and the held-back tool call appear
    // together, in that order.
    expect(afterMore?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          { kind: "text", text: "Let me check Slack for a broad search." },
          { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
        ],
      }),
    ]);
  });

  it("survives a React StrictMode replay of the same event without double-counting", () => {
    // StrictMode invokes a setState updater twice per event in development to catch impure
    // updaters — reduceThreadSnapshot(prev, event) must return the same result both times
    // rather than mutating its pending-tool-call bookkeeping a second time.
    const initial = snapshot([]);
    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check ", streaming: true },
      }),
    );
    const toolEvent = event({
      type: "agent.tool.called",
      seq: 5,
      runId: "run-1",
      payload: { name: "SLACK_FIND_CHANNELS" },
    });

    // The tool call lands mid-sentence, so it's held back rather than flushed immediately —
    // exactly the state a naive module-level mutation would double-push on replay.
    const first = reduceThreadSnapshot(afterNarration, toolEvent);
    const replay = reduceThreadSnapshot(afterNarration, toolEvent);
    expect(replay).toEqual(first);

    const sentenceEnd = reduceThreadSnapshot(
      first,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "Done.", streaming: true },
      }),
    );

    // A single tool call, not two — StrictMode's replay must not have pushed it twice.
    expect(sentenceEnd?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          { kind: "text", text: "Let me check Done." },
          { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
        ],
      }),
    ]);
  });

  it("keeps deferring a tool call across several sentence-less deltas", () => {
    const initial = snapshot([]);

    const afterNarration = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { text: "Let me check Slack ", streaming: true },
      }),
    );
    const afterTool = reduceThreadSnapshot(
      afterNarration,
      event({
        type: "agent.tool.called",
        seq: 5,
        runId: "run-1",
        payload: { name: "SLACK_FIND_CHANNELS" },
      }),
    );
    const afterMore = reduceThreadSnapshot(
      afterTool,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "Found it, now sanding", streaming: true },
      }),
    );

    // No sentence terminator has streamed in yet, so the tool call is still hidden and
    // everything so far renders as one continuous progress block.
    expect(afterMore?.messages).toEqual([
      expect.objectContaining({
        id: "progress:run-1",
        blocks: [
          {
            kind: "progress",
            text: "Let me check Slack Found it, now sanding",
            pendingToolNames: ["SLACK_FIND_CHANNELS"],
          },
        ],
      }),
    ]);
  });

  it("restores pending tool calls from a refreshed snapshot", () => {
    const refreshed = snapshot([
      message("progress:run-1", [
        {
          kind: "progress",
          text: "Let me check Slack ",
          pendingToolNames: ["SLACK_FIND_CHANNELS"],
        },
      ]),
    ]);

    const next = reduceThreadSnapshot(
      refreshed,
      event({
        type: "thread.progress",
        seq: 6,
        runId: "run-1",
        payload: { delta: "now.", streaming: true },
      }),
    );

    expect(next?.messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check Slack now." },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
  });

  it("does not leak pending tool calls after clearing a thread", () => {
    const withPending = snapshot([
      message("progress:run-1", [
        {
          kind: "progress",
          text: "Old unfinished narration ",
          pendingToolNames: ["SLACK_FIND_CHANNELS"],
        },
      ]),
    ]);
    const cleared = reduceThreadSnapshot(
      withPending,
      event({ type: "thread.cleared", seq: 7, runId: undefined }),
    );
    const next = reduceThreadSnapshot(
      cleared,
      event({ type: "thread.progress", seq: 8, runId: "run-1", payload: { text: "Fresh." } }),
    );

    expect(next?.messages[0]?.blocks).toEqual([{ kind: "progress", text: "Fresh." }]);
  });

  it("preserves another active group run while updating live progress", () => {
    const runA = {
      id: "run-a",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running" as const,
      trigger: "user" as const,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
    };
    const otherLive = {
      ...message("progress:run-b", [{ kind: "progress" as const, text: "Other bot" }]),
      botId: "bot-b",
      runId: "run-b",
    };
    // The snapshot can lag behind the event stream when another group run starts.
    const initial = { ...snapshot([otherLive]), activeRuns: [runA] };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.progress",
        seq: 8,
        runId: "run-a",
        botId: "bot-a",
        payload: { text: "Current bot" },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["progress:run-b", "progress:run-a"]);
    expect(next?.messages.map((item) => item.botId)).toEqual(["bot-b", "bot-a"]);
  });

  it("preserves live progress from a legacy run-only snapshot", () => {
    const legacyRun = threadRun("run-legacy", "bot-legacy");
    const legacyLive = {
      ...message("progress:run-legacy", [{ kind: "progress" as const, text: "Still working" }]),
      botId: legacyRun.botId,
      runId: legacyRun.id,
    };
    const initial: ThreadSnapshot = {
      ...snapshot([legacyLive]),
      run: legacyRun,
      activeRuns: undefined,
    };

    const next = reduceThreadSnapshot(
      initial,
      event({ type: "thread.progress", runId: "run-new", payload: { text: "New work" } }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual([
      "progress:run-legacy",
      "progress:run-new",
    ]);
  });

  it("preserves concurrent progress while applying a subagent update", () => {
    const activeRun = threadRun("run-active");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-active", [{ kind: "progress", text: "Active" }]),
          runId: "run-active",
        },
        {
          ...message("progress:run-concurrent", [{ kind: "progress", text: "Concurrent" }]),
          runId: "run-concurrent",
        },
      ]),
      run: activeRun,
      activeRuns: [activeRun],
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.subagent",
        runId: "run-active",
        payload: { agentId: "research", name: "Research", task: "Check", status: "running" },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual([
      "subagent:research",
      "progress:run-active",
      "progress:run-concurrent",
    ]);
  });

  it("clears the step trail once the durable answer arrives", () => {
    const initial = snapshot([
      message("progress:run-1", [
        { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
      ]),
    ]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "final", role: "bot", blocks: [{ kind: "text", text: "Done" }] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["final"]);
  });

  it("updates a waiting group run without replacing the newer active run", () => {
    const newerRun = {
      id: "run-newer",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running" as const,
      trigger: "user" as const,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
    };
    const waitingRun = { ...newerRun, id: "run-waiting", botId: "bot-b", taskId: "task-b" };
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: newerRun,
      activeRuns: [newerRun, waitingRun],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: "run-waiting" }),
    );

    expect(waiting?.run).toEqual(newerRun);
    expect(waiting?.activeRuns?.find((run) => run.id === "run-waiting")?.status).toBe(
      "waiting_input",
    );
    expect(activeThreadRuns(waiting)).toEqual([
      newerRun,
      expect.objectContaining({ id: "run-waiting", status: "waiting_input" }),
    ]);
    expect(activeThreadRuns({ ...initial, activeRuns: undefined })).toEqual([newerRun]);
  });

  it("replaces an ask message when its durable prompt state changes", () => {
    const initial = snapshot([
      message("ask-1", [{ kind: "ask", text: "Which city?", status: "pending" }]),
    ]);
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.updated",
        seq: 7,
        payload: {
          messageId: "ask-1",
          role: "bot",
          blocks: [
            {
              kind: "ask",
              text: "Which city?",
              status: "answered",
              answer: "Paris",
            },
          ],
        },
      }),
    );

    expect(next?.messages).toHaveLength(1);
    expect(next?.messages[0]?.blocks[0]).toMatchObject({ status: "answered", answer: "Paris" });
  });

  it("preserves botId on durable bot messages", () => {
    const initial = snapshot([]);
    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 4,
        botId: "bot-researcher",
        payload: {
          messageId: "msg-1",
          role: "bot",
          blocks: [{ kind: "text", text: "on it." }],
        },
      }),
    );

    expect(next?.messages[0]?.botId).toBe("bot-researcher");
  });
});

describe("computer event reduction", () => {
  it("applies valid lifecycle states without accepting unknown states", () => {
    const initial = computer();
    const running = reduceComputerStatus(
      initial,
      event({ type: "computer.status", payload: { status: "running" } }),
    );
    const unknown = reduceComputerStatus(
      running,
      event({ type: "computer.status", payload: { status: "destroyed" } }),
    );

    expect(running).toMatchObject({ state: "running", screenAvailable: true });
    expect(unknown).toMatchObject({ state: "running", screenAvailable: true });
    expect(unknown).toBe(running);
  });

  it("grants user control without overwriting the lifecycle state", () => {
    const granted = reduceComputerStatus(
      computer({ state: "suspended", controlHolder: "bot" }),
      event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
    );
    expect(granted).toMatchObject({
      state: "suspended",
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
    });
    expect(
      reduceComputerStatus(
        granted,
        event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
      ),
    ).toBe(granted);
  });

  it("applies the authoritative holder when a takeover is released or expires", () => {
    const initial = computer({
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
    });
    const expired = reduceComputerStatus(
      initial,
      event({
        type: "computer.takeover.released",
        payload: { holder: "none", reason: "expired" },
      }),
    );
    const released = reduceComputerStatus(
      initial,
      event({
        type: "computer.takeover.released",
        payload: { holder: "bot", reason: "released" },
      }),
    );
    expect(expired).toMatchObject({
      state: "running",
      controlHolder: "none",
      controlBotId: null,
      takeoverRequested: false,
    });
    expect(released).toMatchObject({
      state: "running",
      controlHolder: "bot",
      controlBotId: null,
      takeoverRequested: false,
    });
  });

  it("fills in controlBotId when a grant arrives after controlHolder is already user", () => {
    const granted = reduceComputerStatus(
      computer({ state: "running", controlHolder: "user", controlBotId: null }),
      event({ type: "computer.takeover.granted", payload: {} }),
    );
    expect(granted).toMatchObject({
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
    });
    expect(userHoldsComputerControl(granted, "bot-1")).toBe(true);
    expect(userHoldsComputerControl(granted, "bot-2")).toBe(false);
  });

  it("auto-boots stopped computers and recovers a running screen that has no URL", () => {
    expect(computerPanelAutoBoot("stopped")).toBe("boot");
    expect(computerPanelAutoBoot("error")).toBe("boot");
    expect(computerPanelAutoBoot(undefined)).toBe("boot");
    expect(computerPanelAutoBoot("running", "https://screen.example")).toBe("wait");
    expect(computerPanelAutoBoot("running", null)).toBe("recover-screen");
    expect(computerPanelAutoBoot("booting")).toBe("wait");
    expect(computerPanelAutoBoot("suspended")).toBe("wait");
  });
});

function snapshot(messages: ThreadMessage[], olderCursor: number | null = null): ThreadSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 3,
    messages,
    olderCursor,
    run: null,
    computer: computer(),
  };
}

function threadRun(id: string, botId = "bot-1"): NonNullable<ThreadSnapshot["run"]> {
  return {
    id,
    botId,
    threadId: "thread-1",
    taskId: `task-${id}`,
    status: "running",
    trigger: "user",
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
  };
}

function computer(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "fake",
    state: "booting",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    ...overrides,
  };
}

function message(id: string, blocks: ThreadMessage["blocks"], seq = 3): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq,
    role: "bot",
    blocks,
    createdAt: "2026-08-16T00:00:00.000Z",
  };
}

function event(overrides: Partial<ProductEvent>): ProductEvent {
  return {
    id: "event-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq: 4,
    type: "thread.progress",
    runId: "run-1",
    createdAt: "2026-08-16T00:00:01.000Z",
    payload: {},
    ...overrides,
  };
}
