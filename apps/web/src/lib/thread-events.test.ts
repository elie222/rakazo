import type {
  ComputerStatus,
  ProductEvent,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  activeThreadRuns,
  clearActiveThreadRuns,
  computerPanelAutoBoot,
  computerPanelAutoUsesBoot,
  computerTakeoverBlocked,
  isThreadSnapshotEvent,
  mergeThreadSnapshot,
  prependThreadMessagePage,
  reconcileRefreshedThread,
  reduceComputerStatus,
  reduceThreadSnapshot,
  threadRunError,
  userHoldsComputerControl,
} from "./thread-events.js";

describe("thread event reduction", () => {
  it("applies a persisted thumbs-up event to its message", () => {
    const initial = snapshot([message("message-1", [{ kind: "text", text: "Done" }], 1)]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.reaction",
        seq: 4,
        payload: { messageId: "message-1", thumbsUp: true },
      }),
    );

    expect(next?.messages[0]?.thumbsUp).toBe(true);
    expect(next?.cursor).toBe(4);
  });

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

  it("ignores a stale thread refresh that is behind the live cursor", () => {
    const live: ThreadSnapshot = {
      ...snapshot([
        message("ask-1", [{ kind: "ask", text: "Which city?", status: "pending" }], 11),
      ]),
      cursor: 12,
    };
    const stale: ThreadSnapshot = {
      ...snapshot([message("m-1", [{ kind: "text", text: "older" }], 1)]),
      cursor: 8,
    };

    expect(mergeThreadSnapshot(live, stale)).toBe(live);
    expect(mergeThreadSnapshot(live, stale, true)).toBe(live);
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

    expect(next?.messages.map((item) => item.id)).toEqual(["durable", "subagent:other"]);
    expect(next?.messages[0]?.blocks).toEqual([completedBlock]);
  });

  it("keeps a replayed bot-to-bot marker in its durable transcript position", () => {
    const peerBlock = {
      kind: "bot_message_received" as const,
      fromBotId: "bot-peer",
      fromBotName: "Peer",
      text: "Please check this.",
    };
    const initial = snapshot([
      message("peer-message", [peerBlock], 1),
      message("newer-message", [{ kind: "text", text: "Working on it." }], 2),
    ]);

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "thread.message.created",
        seq: 9,
        payload: { messageId: "peer-message", role: "user", blocks: [peerBlock] },
      }),
    );

    expect(next?.messages.map((item) => item.id)).toEqual(["peer-message", "newer-message"]);
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
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
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
    expect(isThreadSnapshotEvent(event({ type: "computer.takeover.requested" }))).toBe(true);
  });

  it("event-sources the active run on run.started so Stop does not wait on threads.get", () => {
    const initial = snapshot([]);
    const started = reduceThreadSnapshot(
      initial,
      event({
        type: "run.started",
        seq: 3,
        runId: "run-1",
        payload: { trigger: "user" },
      }),
    );

    expect(started?.run).toMatchObject({
      id: "run-1",
      botId: "bot-1",
      status: "running",
      trigger: "user",
    });
    expect(started?.activeRuns).toEqual([started?.run]);

    const progressed = reduceThreadSnapshot(
      started,
      event({
        type: "thread.progress",
        seq: 4,
        runId: "run-1",
        payload: { delta: "still working" },
      }),
    );
    expect(progressed?.run?.id).toBe("run-1");
    expect(progressed?.cursor).toBe(4);
  });

  it("preserves bot_message when event-sourcing a peer run", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        runId: "peer-run-1",
        payload: { trigger: "bot_message" },
      }),
    );

    expect(started?.run?.trigger).toBe("bot_message");
  });

  it("preserves webhook when event-sourcing an inbound wake", () => {
    const started = reduceThreadSnapshot(
      snapshot([]),
      event({
        type: "run.started",
        runId: "webhook-run-1",
        payload: { trigger: "webhook" },
      }),
    );

    expect(started?.run?.trigger).toBe("webhook");
  });

  it("marks the run as waiting when computer takeover is requested", () => {
    const run = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run,
      activeRuns: [run],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "computer.takeover.requested", seq: 5, runId: run.id }),
    );

    expect(waiting?.run?.status).toBe("waiting_takeover");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_takeover");
  });

  it("keeps event-sourced waiting_takeover when a stale refresh still shows the bot busy", () => {
    const run = threadRun("run-1");
    const waitingLocal: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 10,
      run: { ...run, status: "waiting_takeover" },
      activeRuns: [{ ...run, status: "waiting_takeover" }],
    };
    const staleRefresh: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 10,
      run,
      activeRuns: [run],
      computer: computer({ state: "running", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(
      waitingLocal,
      staleRefresh,
      computer({ state: "running", busyBotName: null }),
    );

    expect(reconciled.snapshot.run?.status).toBe("waiting_takeover");
    expect(reconciled.computer?.busyBotName).toBeNull();
    expect(computerTakeoverBlocked(reconciled.computer, reconciled.snapshot.run?.status)).toBe(
      false,
    );
  });

  it("ignores a refresh whose cursor is behind the event-sourced snapshot", () => {
    const run = threadRun("run-1");
    const newer: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 12,
      run: { ...run, status: "waiting_takeover" },
    };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 9,
      run,
      computer: computer({ busyBotName: "Chief" }),
    };
    const prevComputer = computer({ busyBotName: null });

    const reconciled = reconcileRefreshedThread(newer, older, prevComputer);

    expect(reconciled.snapshot).toBe(newer);
    expect(reconciled.computer).toBe(prevComputer);
  });

  it("refreshes busy status when only transient thread events are ahead", () => {
    const run = threadRun("run-1");
    const newer: ThreadSnapshot = { ...snapshot([]), cursor: 12, run };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 9,
      run,
      computer: computer({ state: "running", controlHolder: "bot", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(
      newer,
      older,
      computer({ state: "running", controlHolder: "bot", busyBotName: null }),
    );

    expect(reconciled.snapshot).toBe(newer);
    expect(reconciled.computer?.busyBotName).toBe("Chief");
  });

  it("hydrates a live run from a refresh without rolling back newer progress", () => {
    const run = threadRun("run-1");
    const liveProgress = {
      ...message("progress:run-1", [{ kind: "progress" as const, text: "Still working" }]),
      runId: run.id,
    };
    const newer: ThreadSnapshot = { ...snapshot([liveProgress]), cursor: 12, run: null };
    const older: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 11,
      run,
      computer: computer({ state: "running", controlHolder: "bot", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(newer, older, computer());

    expect(reconciled.snapshot.cursor).toBe(12);
    expect(reconciled.snapshot.messages).toEqual([liveProgress]);
    expect(reconciled.snapshot.run).toBe(run);
    expect(reconciled.computer?.busyBotName).toBe("Chief");
  });

  it("clears active runs and their transient progress after stop", () => {
    const run = threadRun("run-1");
    const durable = message("message-1", [{ kind: "text", text: "Keep me" }]);
    const progress = {
      ...message("progress:run-1", [{ kind: "progress" as const, text: "Still working" }]),
      runId: run.id,
    };
    const stopped = clearActiveThreadRuns({
      ...snapshot([durable, progress]),
      run,
      activeRuns: [run],
      computer: computer({ state: "running", busyBotName: "Chief" }),
    });

    expect(stopped.run).toBeNull();
    expect(stopped.activeRuns).toEqual([]);
    expect(stopped.messages).toEqual([durable]);
    expect(stopped.computer?.busyBotName).toBeNull();
  });

  it("keeps an optimistic stop clear when an older cursor refresh still looks busy", () => {
    // Stop has no terminal event, so progress can leave the local cursor ahead of threads.get.
    // After the shell clears run/busy locally, that older get must not restore Stop / Take control block.
    const run = threadRun("run-1");
    const stoppedLocal: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 15,
      run: null,
      activeRuns: [],
      computer: computer({ state: "running", busyBotName: null }),
    };
    const staleBusyRefresh: ThreadSnapshot = {
      ...snapshot([]),
      cursor: 10,
      run,
      activeRuns: [run],
      computer: computer({ state: "running", busyBotName: "Chief" }),
    };
    const clearedComputer = computer({ state: "running", busyBotName: null });

    const reconciled = reconcileRefreshedThread(stoppedLocal, staleBusyRefresh, clearedComputer);

    expect(reconciled.snapshot.run).toBeNull();
    expect(reconciled.snapshot.activeRuns).toEqual([]);
    expect(reconciled.computer?.busyBotName).toBeNull();
    expect(computerTakeoverBlocked(reconciled.computer, reconciled.snapshot.run?.status)).toBe(
      false,
    );
  });

  it("always replaces the snapshot when switching to a different thread", () => {
    const previous: ThreadSnapshot = {
      ...snapshot([]),
      threadId: "thread-writer",
      cursor: 40,
      computer: computer({ mode: "team", busyBotName: null }),
    };
    const next: ThreadSnapshot = {
      ...snapshot([]),
      botId: "bot-private",
      threadId: "thread-private",
      cursor: 0,
      computer: computer({ mode: "dedicated", state: "running" }),
    };

    const reconciled = reconcileRefreshedThread(previous, next, previous.computer ?? null);

    expect(reconciled.snapshot.threadId).toBe("thread-private");
    expect(reconciled.computer?.mode).toBe("dedicated");
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
    expect(started?.run?.id).toBe(run.id);
    expect(started?.run?.status).toBe("running");
    expect(started?.activeRuns?.map((item) => item.id)).toEqual([run.id]);

    const waiting = reduceThreadSnapshot(
      started!,
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

  it("keeps a failed run and its error so the thread can surface the failure", () => {
    const failing = threadRun("run-a");
    const initial: ThreadSnapshot = {
      ...snapshot([
        { ...message("progress:run-a", [{ kind: "progress", text: "A" }]), runId: failing.id },
      ]),
      run: failing,
    };
    const failed = event({
      type: "run.failed",
      seq: 11,
      runId: failing.id,
      payload: { error: "Provider is not configured: openrouter" },
    });

    const next = reduceThreadSnapshot(initial, failed);

    expect(next?.messages).toEqual([]);
    expect(next?.run).toMatchObject({
      id: failing.id,
      status: "failed",
      error: "Provider is not configured: openrouter",
    });
    expect(threadRunError(next)).toBe("Provider is not configured: openrouter");
    expect(threadRunError(next, new Set([failing.id]))).toBeNull();
    expect(threadRunError(next, new Set(["other-run"]))).toBe(
      "Provider is not configured: openrouter",
    );
  });

  it("keeps the error when a member run fails while another member is still running", () => {
    const runA = threadRun("run-a", "bot-a");
    const runB = threadRun("run-b", "bot-b");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      run: runA,
      activeRuns: [runA, runB],
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "run.failed",
        seq: 13,
        botId: "bot-b",
        runId: runB.id,
        payload: { error: "member exploded" },
      }),
    );

    expect(next?.activeRuns).toEqual([runA]);
    expect(next?.run).toMatchObject({ id: runB.id, status: "failed", error: "member exploded" });
    expect(threadRunError(next)).toBe("member exploded");
  });

  it("keeps a group failure visible when another member starts before dismiss", () => {
    const failed = {
      ...threadRun("run-b", "bot-b"),
      status: "failed" as const,
      error: "member exploded",
    };
    const runA = threadRun("run-a", "bot-a");
    const initial: ThreadSnapshot = {
      ...snapshot([]),
      groupId: "group-1",
      run: failed,
      activeRuns: [runA],
    };

    const next = reduceThreadSnapshot(
      initial,
      event({
        type: "run.started",
        seq: 14,
        botId: "bot-c",
        runId: "run-c",
      }),
    );

    expect(next?.run).toMatchObject({ id: failed.id, status: "failed", error: "member exploded" });
    expect(next?.activeRuns).toEqual([
      runA,
      expect.objectContaining({ id: "run-c", botId: "bot-c", status: "running" }),
    ]);
    expect(threadRunError(next)).toBe("member exploded");
  });

  it("clears the run and reports no error when it completes or fails without a message", () => {
    const finishing = threadRun("run-a");
    const initial: ThreadSnapshot = { ...snapshot([]), run: finishing };

    const completed = reduceThreadSnapshot(
      initial,
      event({ type: "run.completed", seq: 12, runId: finishing.id }),
    );
    const blank = reduceThreadSnapshot(
      initial,
      event({ type: "run.failed", seq: 12, runId: finishing.id, payload: { error: "  " } }),
    );

    expect(completed?.run).toBeNull();
    expect(threadRunError(completed)).toBeNull();
    expect(blank?.run).toBeNull();
    expect(threadRunError(blank)).toBeNull();
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
        routineId: null,
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: null,
        completedAt: null,
        createdAt: "2026-08-16T00:00:00.000Z",
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

  it("clears live progress when a run waits for input", () => {
    const run = threadRun("run-1");
    const initial: ThreadSnapshot = {
      ...snapshot([
        {
          ...message("progress:run-1", [{ kind: "progress", text: "working…" }]),
          runId: run.id,
        },
      ]),
      run,
      activeRuns: [run],
    };

    const waiting = reduceThreadSnapshot(
      initial,
      event({ type: "run.waiting_input", seq: 6, runId: run.id }),
    );

    expect(waiting?.messages).toEqual([]);
    expect(waiting?.run?.status).toBe("waiting_input");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_input");
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
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
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
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-16T00:00:00.000Z",
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

  it("treats a busy bot name as a blocked takeover", () => {
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }), "running")).toBe(true);
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }))).toBe(false);
    expect(computerTakeoverBlocked(computer({ busyBotName: null }), "running")).toBe(false);
    expect(computerTakeoverBlocked(null, "running")).toBe(false);
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }), "waiting_takeover")).toBe(
      false,
    );
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }), "completed")).toBe(false);
  });

  it("clears the busy bot when takeover is requested or granted", () => {
    const busy = computer({ state: "running", busyBotName: "Writer" });
    expect(
      reduceComputerStatus(busy, event({ type: "computer.takeover.requested", payload: {} })),
    ).toMatchObject({ busyBotName: null });
    expect(
      reduceComputerStatus(
        busy,
        event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
      ),
    ).toMatchObject({
      controlHolder: "user",
      busyBotName: null,
      takeoverRequested: true,
    });
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

  it("maps recover-screen to computer.boot, not computer.recover", () => {
    expect(computerPanelAutoUsesBoot("recover-screen")).toBe(true);
    expect(computerPanelAutoUsesBoot("boot")).toBe(true);
    expect(computerPanelAutoUsesBoot("wait")).toBe(false);
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
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-08-16T00:00:00.000Z",
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
    updateAvailable: true,
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
    spaceId: "workspace-1",
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
