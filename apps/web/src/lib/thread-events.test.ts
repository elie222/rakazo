import type {
  ComputerStatus,
  ProductEvent,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { reconcileRefreshedThread, reduceThreadSnapshot } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  clearActiveThreadRuns,
  computerPanelNeedsMaintenance,
  computerPanelNeedsScreen,
  computerTakeoverBlocked,
  reduceComputerStatus,
  screenMissing,
  screenReadLoaded,
  threadRunError,
  userHoldsComputerControl,
} from "./thread-events.js";

describe("thread event reduction with web state", () => {
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

  it("leaves another person's control to them until it is released", () => {
    const watching = computer({
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
      controlledByOther: true,
    });
    expect(userHoldsComputerControl(watching, "bot-1")).toBe(false);
    const released = reduceComputerStatus(
      watching,
      event({ type: "computer.takeover.released", payload: { holder: "none" } }),
    );
    expect(released?.controlledByOther).toBeUndefined();
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

  it("ignores computer events that belong to a different bot", () => {
    const prev = computer({ takeoverRequested: false, controlHolder: "bot" });
    expect(
      reduceComputerStatus(
        prev,
        event({
          type: "computer.takeover.requested",
          botId: "bot-peer",
          payload: {},
        }),
      ),
    ).toBe(prev);
    expect(
      reduceComputerStatus(
        prev,
        event({
          type: "computer.status",
          botId: "bot-peer",
          payload: { status: "suspended" },
        }),
      ),
    ).toBe(prev);
  });

  it("marks takeover requested and clears control unless the lease was retained", () => {
    const busy = computer({ state: "running", busyBotName: "Writer", controlHolder: "bot" });
    expect(
      reduceComputerStatus(busy, event({ type: "computer.takeover.requested", payload: {} })),
    ).toMatchObject({
      busyBotName: null,
      takeoverRequested: true,
      controlHolder: "none",
      controlBotId: null,
    });
    expect(
      reduceComputerStatus(
        computer({
          state: "running",
          controlHolder: "user",
          controlBotId: "bot-1",
          takeoverRequested: false,
        }),
        event({
          type: "computer.takeover.requested",
          payload: { retainedControl: true },
        }),
      ),
    ).toMatchObject({
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
      busyBotName: null,
    });
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

  it("only reconnects a running computer whose screen has no URL", () => {
    expect(computerPanelNeedsScreen("running", null)).toBe(true);
    expect(computerPanelNeedsScreen("running", "https://screen.example")).toBe(false);
    expect(computerPanelNeedsScreen("stopped")).toBe(false);
    expect(computerPanelNeedsScreen("error")).toBe(false);
    expect(computerPanelNeedsScreen(undefined)).toBe(false);
    expect(computerPanelNeedsScreen("booting")).toBe(false);
    expect(computerPanelNeedsScreen("suspended")).toBe(false);
  });

  it("waits for this computer's screen read before diagnosing a missing screen", () => {
    const options = {
      state: "running" as const,
      kind: undefined,
      booting: false,
      screenUrlLoaded: false,
      embeddedUrl: null,
    };
    expect(screenMissing(options)).toBe(false);
    expect(screenMissing({ ...options, screenUrlLoaded: true })).toBe(true);
    expect(
      screenMissing({ ...options, screenUrlLoaded: true, embeddedUrl: "https://screen.example" }),
    ).toBe(false);
    expect(screenMissing({ ...options, screenUrlLoaded: true, booting: true })).toBe(false);
    expect(screenMissing({ ...options, screenUrlLoaded: true, kind: "desktop" })).toBe(false);
    expect(screenMissing({ ...options, screenUrlLoaded: true, state: "error" })).toBe(false);
  });

  it("shows maintenance for an errored computer that is not booting, or a stalled boot", () => {
    expect(computerPanelNeedsMaintenance({ state: "error" }, false)).toBe(true);
    expect(computerPanelNeedsMaintenance({ state: "stopped" }, false)).toBe(false);
    expect(computerPanelNeedsMaintenance({ state: "error" }, true)).toBe(false);
    expect(computerPanelNeedsMaintenance({ state: "running" }, false)).toBe(false);
    expect(computerPanelNeedsMaintenance(undefined, false)).toBe(false);
    expect(computerPanelNeedsMaintenance({ state: "booting", bootStalled: true }, true)).toBe(true);
  });

  it("hides side-panel maintenance while the computer overlay is open", () => {
    const panel = "computer";
    const booting = false;
    const showInSidePanel = (computerOpen: boolean) =>
      panel === "computer" &&
      !computerOpen &&
      computerPanelNeedsMaintenance({ state: "error" }, booting);

    expect(showInSidePanel(false)).toBe(true);
    expect(showInSidePanel(true)).toBe(false);
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
    canRestart: true,
    terminalAvailable: true,
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

describe("screen read ownership", () => {
  it("does not promote a booting read into a running-screen failure", () => {
    expect(screenReadLoaded("booting", "running")).toBe(false);
    expect(screenReadLoaded("running", "booting")).toBe(false);
    expect(screenReadLoaded("running", "running")).toBe(true);
  });
});
