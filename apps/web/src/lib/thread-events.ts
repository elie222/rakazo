import type {
  ComputerStatus,
  ProductEvent,
  Run,
  RunStatus,
  ThreadMessage,
  ThreadMessagePage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  isActive,
  isRunTerminalEvent,
  mergeThreadHistory,
  prependThreadHistoryPage,
  progressMessageId,
  reduceLiveMessageBlocks,
  runFailureError,
  subagentBlockFromPayload,
  upsertMessageById,
} from "@rakazo/core";

const runTriggers = new Set<Run["trigger"]>([
  "user",
  "routine",
  "resume",
  "follow_up",
  "spawn",
  "skill",
  "bot_message",
  "webhook",
  "messaging",
]);

function runFromStartedEvent(event: ProductEvent, previous: Run | undefined): Run {
  const trigger = event.payload.trigger;
  return {
    id: event.runId ?? previous?.id ?? event.id,
    botId: event.botId,
    threadId: event.threadId,
    taskId: previous?.taskId ?? event.runId ?? event.id,
    status: "running",
    trigger:
      typeof trigger === "string" && runTriggers.has(trigger as Run["trigger"])
        ? (trigger as Run["trigger"])
        : (previous?.trigger ?? "user"),
    routineId:
      typeof event.payload.routineId === "string"
        ? event.payload.routineId
        : (previous?.routineId ?? null),
    modelProvider: previous?.modelProvider ?? null,
    modelId: previous?.modelId ?? null,
    error: null,
    startedAt: previous?.startedAt ?? event.createdAt,
    completedAt: null,
    createdAt: previous?.createdAt ?? event.createdAt,
  };
}

function takeLiveMessage(
  messages: readonly ThreadMessage[],
  liveId: string,
): { previous: ThreadMessage | undefined; remaining: ThreadMessage[] } {
  let previous: ThreadMessage | undefined;
  const remaining: ThreadMessage[] = [];
  for (const message of messages) {
    if (message.id === liveId) {
      previous = message;
    } else if (!message.id.startsWith("progress:") || message.runId) {
      remaining.push(message);
    }
  }
  return { previous, remaining };
}

const computerStates: ReadonlySet<unknown> = new Set<ComputerStatus["state"]>([
  "stopped",
  "booting",
  "running",
  "suspended",
  "error",
]);

export function activeThreadRuns(
  snapshot: ThreadSnapshot | null,
): NonNullable<ThreadSnapshot["activeRuns"]> {
  return snapshot?.activeRuns ?? (snapshot?.run ? [snapshot.run] : []);
}

/**
 * Reflect a committed direct-message send before its follow-up snapshot arrives.
 *
 * threads.send returns only after the message and run are durable. Keeping that
 * receipt prevents a transient snapshot/SSE interruption from showing a stored
 * user bubble with no working state. A matching live run always wins, and the
 * next durable event or refresh still supplies the authoritative status.
 */
export function applyThreadSendReceipt(
  snapshot: ThreadSnapshot | null,
  receipt: { botId: string; runId: string; taskId: string; createdAt?: string },
  terminalRunIds: ReadonlySet<string> = new Set(),
): ThreadSnapshot | null {
  if (
    !snapshot ||
    snapshot.groupId ||
    snapshot.botId !== receipt.botId ||
    snapshot.run?.id === receipt.runId ||
    terminalRunIds.has(receipt.runId)
  ) {
    return snapshot;
  }
  const currentRuns = activeThreadRuns(snapshot);
  if (currentRuns.some((run) => isActive(run.status as RunStatus))) return snapshot;
  const createdAt = receipt.createdAt ?? new Date().toISOString();
  const run: Run = {
    id: receipt.runId,
    botId: receipt.botId,
    threadId: snapshot.threadId,
    taskId: receipt.taskId,
    status: "queued",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt,
  };
  return { ...snapshot, run, activeRuns: [run] };
}

/** Reason the newest run stopped, until the reader dismisses that run's failure. */
export function threadRunError(
  snapshot: ThreadSnapshot | null,
  dismissedRunIds?: ReadonlySet<string>,
): string | null {
  const run = snapshot?.run;
  if (run?.status !== "failed" || dismissedRunIds?.has(run.id)) return null;
  return run.error ?? null;
}

export function clearActiveThreadRuns(snapshot: ThreadSnapshot): ThreadSnapshot {
  const runIds = new Set(activeThreadRuns(snapshot).map((run) => run.id));
  const computer = snapshot.computer?.busyBotName
    ? { ...snapshot.computer, busyBotName: null }
    : snapshot.computer;
  return {
    ...snapshot,
    run: null,
    activeRuns: [],
    messages: snapshot.messages.filter(
      (message) =>
        !message.runId || !runIds.has(message.runId) || !message.id.startsWith("progress:"),
    ),
    computer,
  };
}

export function mergeThreadSnapshot(
  prev: ThreadSnapshot | null,
  next: ThreadSnapshot,
  preserveLoadedHistory = false,
): ThreadSnapshot {
  // A threads.get started before SSE caught up must not wipe newer live state
  // (e.g. ask cards applied after send's post-refresh request was already in flight).
  if (prev && prev.threadId === next.threadId && prev.cursor > next.cursor) return prev;
  return mergeThreadHistory(prev, next, preserveLoadedHistory);
}

/**
 * Apply a threads.get refresh without clobbering newer event-sourced takeover state.
 *
 * A refresh that started earlier can still return running+busyBotName after the client
 * already applied waiting_takeover. Cursor comparisons only apply within the same thread.
 * Stop clears run/busy optimistically in the shell because it has no terminal event; an
 * older-cursor refresh must keep that cleared local state (see Shell stopRun).
 */
export function reconcileRefreshedThread(
  prev: ThreadSnapshot | null,
  snap: ThreadSnapshot,
  prevComputer: ComputerStatus | null,
  preserveLoadedHistory = false,
): { snapshot: ThreadSnapshot; computer: ComputerStatus | null } {
  const sameThread = Boolean(prev && prev.threadId === snap.threadId);

  if (sameThread && prev && snap.cursor < prev.cursor) {
    // A subscription can advance the cursor with progress before the send-triggered refresh
    // returns the new run record. Hydrate that matching run without rolling the transcript back.
    // Optimistic stop removes the matching progress message, so an older refresh cannot revive it.
    const refreshedRun = snap.run;
    const hasMatchingLiveProgress = Boolean(
      refreshedRun &&
        prev.messages.some(
          (message) =>
            message.runId === refreshedRun.id && message.id === `progress:${refreshedRun.id}`,
        ),
    );
    if (!prev.run && refreshedRun && hasMatchingLiveProgress) {
      return {
        snapshot: {
          ...prev,
          run: refreshedRun,
          activeRuns: snap.activeRuns,
          computer: snap.computer,
        },
        computer: snap.computer ?? null,
      };
    }
    // Progress can advance the thread cursor while embedded computer status from threads.get
    // is still useful — but only while a live run remains. Preserve event-sourced
    // waiting_takeover clears and optimistic stop clears.
    const preserveLocalComputer =
      prev.run?.status === "waiting_takeover" ||
      !prev.run ||
      !isActive(prev.run.status as RunStatus);
    return {
      snapshot: prev,
      computer: preserveLocalComputer ? prevComputer : (snap.computer ?? null),
    };
  }

  let snapshot = mergeThreadSnapshot(prev, snap, preserveLoadedHistory);
  let computer = snap.computer ?? null;

  const localWaiting =
    sameThread &&
    prev?.run?.status === "waiting_takeover" &&
    snapshot.run?.id === prev.run.id &&
    snapshot.run.status !== "waiting_takeover" &&
    isActive(snapshot.run.status as RunStatus);

  if (localWaiting && snapshot.run) {
    const runId = snapshot.run.id;
    snapshot = {
      ...snapshot,
      run: { ...snapshot.run, status: "waiting_takeover" },
      activeRuns: snapshot.activeRuns?.map((run) =>
        run.id === runId ? { ...run, status: "waiting_takeover" } : run,
      ),
    };
    if (computer?.busyBotName) computer = { ...computer, busyBotName: null };
  } else if (snapshot.run?.status === "waiting_takeover" && computer?.busyBotName) {
    computer = { ...computer, busyBotName: null };
  }

  return { snapshot, computer };
}

export function prependThreadMessagePage(
  prev: ThreadSnapshot | null,
  page: ThreadMessagePage,
): ThreadSnapshot | null {
  return prependThreadHistoryPage(prev, page);
}

export function isThreadSnapshotEvent(event: ProductEvent): boolean {
  return (
    event.type === "thread.cleared" ||
    event.type === "thread.progress" ||
    event.type === "thread.subagent" ||
    event.type === "agent.tool.called" ||
    event.type === "thread.message.created" ||
    event.type === "thread.message.updated" ||
    event.type === "thread.message.reaction" ||
    event.type === "run.started" ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested" ||
    isRunTerminalEvent(event)
  );
}

export function reduceThreadSnapshot(
  prev: ThreadSnapshot | null,
  event: ProductEvent,
): ThreadSnapshot | null {
  if (!prev) return prev;
  if (event.type === "thread.cleared") {
    return {
      ...prev,
      cursor: event.seq,
      messages: [],
      olderCursor: null,
      run: null,
      activeRuns: [],
    };
  }
  if (event.type === "run.started") {
    if (!event.runId) {
      return {
        ...prev,
        cursor: event.seq,
        members: updateMemberStatus(prev.members, event.botId, "running"),
      };
    }
    const previousRun =
      prev.activeRuns?.find((candidate) => candidate.id === event.runId) ??
      (prev.run?.id === event.runId ? prev.run : undefined);
    const run = runFromStartedEvent(event, previousRun);
    const without = (prev.activeRuns ?? (prev.run ? [prev.run] : [])).filter(
      (candidate) => candidate.id !== run.id,
    );
    // Bot threads keep a single primary run; groups accumulate concurrent member runs.
    const activeRuns = prev.groupId ? [...without, run] : [run];
    return {
      ...prev,
      cursor: event.seq,
      members: updateMemberStatus(prev.members, event.botId, "running"),
      // A group failure lives only in run; keep it until dismiss so a late member start
      // cannot wipe the banner (activeRuns still tracks the new work).
      run: prev.groupId && prev.run?.status === "failed" && prev.run.id !== run.id ? prev.run : run,
      activeRuns,
    };
  }
  if (event.type === "run.waiting_input" || event.type === "computer.takeover.requested") {
    const status = event.type === "run.waiting_input" ? "waiting_input" : "waiting_takeover";
    const runChanged = Boolean(
      prev.run && prev.run.id === event.runId && prev.run.status !== status,
    );
    const activeRunChanged = prev.activeRuns?.some(
      (candidate) => candidate.id === event.runId && candidate.status !== status,
    );
    const members = updateMemberStatus(prev.members, event.botId, status);
    // Ask pauses delete progress events server-side; drop the live bubble so a missed
    // message.created cannot leave "working…" stuck next to waiting_input.
    const liveId = progressMessageId(event);
    const messages =
      event.type === "run.waiting_input" && prev.messages.some((message) => message.id === liveId)
        ? prev.messages.filter((message) => message.id !== liveId)
        : prev.messages;
    if (
      !runChanged &&
      !activeRunChanged &&
      members === prev.members &&
      messages === prev.messages
    ) {
      return prev;
    }
    return {
      ...prev,
      cursor: event.seq,
      members,
      messages,
      run: runChanged && prev.run ? { ...prev.run, status } : prev.run,
      activeRuns: activeRunChanged
        ? prev.activeRuns?.map((candidate) =>
            candidate.id === event.runId ? { ...candidate, status } : candidate,
          )
        : prev.activeRuns,
    };
  }
  if (isRunTerminalEvent(event)) {
    const activeRuns = prev.activeRuns?.filter((candidate) => candidate.id !== event.runId);
    const nextMemberRun = activeRuns?.find((candidate) => candidate.botId === event.botId);
    const failure = runFailureError(event);
    const primaryEnded = prev.run?.id === event.runId ? prev.run : null;
    // In a group the failing run may be a member run rather than the displayed one, so look
    // it up in activeRuns as well or its error would be dropped with it.
    const endedRun =
      primaryEnded ?? prev.activeRuns?.find((candidate) => candidate.id === event.runId) ?? null;
    return {
      ...prev,
      cursor: event.seq,
      messages: prev.messages.filter((message) => message.id !== progressMessageId(event)),
      members: updateMemberStatus(prev.members, event.botId, nextMemberRun?.status ?? "idle"),
      // A failed run stays in run (activeRuns already excludes it) so the transcript can say
      // why it stopped, matching what threads.get returns on the next load.
      run:
        endedRun && failure
          ? { ...endedRun, status: "failed", error: failure }
          : primaryEnded
            ? (activeRuns?.[0] ?? null)
            : prev.run,
      activeRuns,
    };
  }
  if (event.type === "thread.progress") {
    const liveId = progressMessageId(event);
    const { previous, remaining } = takeLiveMessage(prev.messages, liveId);
    const blocks = reduceLiveMessageBlocks(previous?.blocks ?? [], {
      type: "progress",
      payload: event.payload,
    });
    const streaming: ThreadMessage = {
      id: liveId,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks,
      botId: event.botId,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    return { ...prev, cursor: event.seq, messages: [...remaining, streaming] };
  }
  if (event.type === "agent.tool.called") {
    const liveId = progressMessageId(event);
    const { previous, remaining } = takeLiveMessage(prev.messages, liveId);
    const blocks = reduceLiveMessageBlocks(previous?.blocks ?? [], {
      type: "tool",
      name: String(event.payload.name ?? ""),
    });
    const next: ThreadMessage = {
      id: liveId,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks,
      botId: event.botId,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    return { ...prev, cursor: event.seq, messages: [...remaining, next] };
  }
  if (event.type === "thread.subagent") {
    const block = subagentBlockFromPayload(event.payload);
    const next: ThreadMessage = {
      id: `subagent:${block.agentId}`,
      threadId: event.threadId,
      seq: event.seq,
      role: "bot",
      blocks: [block],
      botId: event.botId,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    const without: ThreadMessage[] = [];
    const kept: ThreadMessage[] = [];
    for (const message of prev.messages) {
      if (message.id === next.id) continue;
      if (message.id.startsWith("progress:")) {
        if (message.runId) kept.push(message);
      } else {
        without.push(message);
      }
    }
    return { ...prev, cursor: event.seq, messages: [...without, next, ...kept] };
  }
  if (event.type === "thread.message.reaction") {
    const messageId = String(event.payload.messageId ?? "");
    return {
      ...prev,
      cursor: event.seq,
      messages: prev.messages.map((message) =>
        message.id === messageId
          ? { ...message, thumbsUp: event.payload.thumbsUp === true }
          : message,
      ),
    };
  }
  if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
    const role = (event.payload.role as ThreadMessage["role"]) ?? "bot";
    const blocks = (event.payload.blocks as ThreadMessage["blocks"]) ?? [];
    const next: ThreadMessage = {
      id: String(event.payload.messageId ?? event.id),
      threadId: event.threadId,
      seq: event.seq,
      role,
      blocks,
      botId: event.botId,
      runId: event.runId,
      thumbsUp: event.payload.thumbsUp === true,
      createdAt: event.createdAt,
    };
    const replacedSubagentIds = new Set(
      blocks.filter((block) => block.kind === "subagent").map((block) => block.agentId),
    );
    const liveId = progressMessageId(event);
    const { remaining } = takeLiveMessage(prev.messages, liveId);
    const without = remaining.filter((message) => !replacedSubagent(message, replacedSubagentIds));
    return { ...prev, cursor: event.seq, messages: upsertMessageById(without, next) };
  }
  return prev;
}

function updateMemberStatus(
  members: ThreadSnapshot["members"],
  botId: string,
  status: string,
): ThreadSnapshot["members"] {
  const member = members?.find((candidate) => candidate.botId === botId);
  if (!member || member.status === status) return members;
  return members?.map((candidate) =>
    candidate.botId === botId ? { ...candidate, status } : candidate,
  );
}

export function userHoldsComputerControl(
  computer: Pick<ComputerStatus, "controlHolder" | "controlBotId"> | null | undefined,
  botId: string | undefined,
): boolean {
  return Boolean(botId && computer?.controlHolder === "user" && computer.controlBotId === botId);
}

/** True when a live bot run is blocking Take control (API would return 409). */
export function computerTakeoverBlocked(
  computer: Pick<ComputerStatus, "busyBotName"> | null | undefined,
  runStatus?: string | null,
): boolean {
  if (!computer?.busyBotName) return false;
  // waiting_takeover is the bot asking for control; terminal/idle clears the block even if
  // busyBotName is briefly stale while the executor still holds the lease in finally.
  if (!runStatus || runStatus === "waiting_takeover") return false;
  return isActive(runStatus as RunStatus);
}

export function computerPanelAutoBoot(
  state: ComputerStatus["state"] | undefined,
  screenUrl?: string | null,
): "boot" | "recover-screen" | "wait" {
  if (state === "booting" || state === "suspended") return "wait";
  if (state === "running") return screenUrl ? "wait" : "recover-screen";
  return "boot";
}

/** Auto panel reconnect must use computer.boot — never computer.recover (that destroys the sandbox). */
export function computerPanelAutoUsesBoot(
  action: ReturnType<typeof computerPanelAutoBoot>,
): boolean {
  return action === "boot" || action === "recover-screen";
}

export function computerPanelNeedsMaintenance(
  state: ComputerStatus["state"] | undefined,
  booting: boolean,
): boolean {
  return !booting && (state === "error" || state === "stopped");
}

export function reduceComputerStatus(
  prev: ComputerStatus | null,
  event: ProductEvent,
): ComputerStatus | null {
  if (!prev) return prev;
  if (!isComputerStatusEvent(event)) return prev;
  if (event.type === "computer.takeover.requested") {
    return prev.busyBotName === null ? prev : { ...prev, busyBotName: null };
  }
  if (event.type === "computer.takeover.granted") {
    const takeoverRequested = event.payload.takeoverRequested === true;
    return prev.controlHolder === "user" &&
      prev.controlBotId === event.botId &&
      prev.takeoverRequested === takeoverRequested &&
      prev.busyBotName === null
      ? prev
      : {
          ...prev,
          controlHolder: "user",
          controlBotId: event.botId,
          takeoverRequested,
          busyBotName: null,
        };
  }
  if (event.type === "computer.takeover.released") {
    const holder = event.payload.holder;
    if (holder !== "bot" && holder !== "none") return prev;
    return prev.controlHolder === holder &&
      prev.controlBotId === null &&
      !prev.takeoverRequested &&
      prev.busyBotName === null
      ? prev
      : {
          ...prev,
          controlHolder: holder,
          controlBotId: null,
          takeoverRequested: false,
          busyBotName: null,
        };
  }
  const status = event.payload.status;
  if (!isComputerState(status)) return prev;
  const screenAvailable = status === "running" || status === "booting" || prev.screenAvailable;
  if (status === prev.state && screenAvailable === prev.screenAvailable) return prev;
  return {
    ...prev,
    state: status,
    screenAvailable,
  };
}

export function isComputerStatusEvent(event: ProductEvent): boolean {
  return (
    event.type === "computer.status" ||
    event.type === "computer.takeover.requested" ||
    event.type === "computer.takeover.granted" ||
    event.type === "computer.takeover.released"
  );
}

function isComputerState(value: unknown): value is ComputerStatus["state"] {
  return computerStates.has(value);
}

function replacedSubagent(message: ThreadMessage, agentIds: ReadonlySet<string>) {
  if (agentIds.size === 0) return false;
  return message.blocks.some((block) => block.kind === "subagent" && agentIds.has(block.agentId));
}
