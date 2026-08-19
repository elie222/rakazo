import type {
  ComputerStatus,
  ProductEvent,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  mergeThreadSnapshot,
  prependThreadMessagePage,
  reduceComputerStatus,
  reduceThreadSnapshot,
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
    const initial = snapshot([
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
      message("progress:run-1", [{ kind: "progress", text: "Draft" }]),
    ]);

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
      event({ type: "computer.takeover.granted", payload: {} }),
    );
    expect(granted).toMatchObject({ state: "suspended", controlHolder: "user" });
    expect(
      reduceComputerStatus(granted, event({ type: "computer.takeover.granted", payload: {} })),
    ).toBe(granted);
  });

  it("applies the authoritative holder when a takeover is released or expires", () => {
    const initial = computer({ state: "running", controlHolder: "user" });
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
    expect(expired).toMatchObject({ state: "running", controlHolder: "none" });
    expect(released).toMatchObject({ state: "running", controlHolder: "bot" });
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

function computer(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "fake",
    state: "booting",
    controlHolder: "none",
    controlBotId: null,
    screenAvailable: false,
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
