import type {
  ComputerStatus,
  ProductEvent,
  ThreadMessage,
  ThreadMessagePage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import {
  isRunTerminalEvent,
  mergeThreadHistory,
  prependThreadHistoryPage,
  progressMessageId,
  reduceLiveMessageBlocks,
  subagentBlockFromPayload,
} from "@rakazo/core";

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

export function mergeThreadSnapshot(
  prev: ThreadSnapshot | null,
  next: ThreadSnapshot,
  preserveLoadedHistory = false,
): ThreadSnapshot {
  return mergeThreadHistory(prev, next, preserveLoadedHistory);
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
    event.type === "run.started" ||
    event.type === "run.waiting_input" ||
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
    return {
      ...prev,
      cursor: event.seq,
      members: updateMemberStatus(prev.members, event.botId, "running"),
    };
  }
  if (event.type === "run.waiting_input") {
    const runChanged = Boolean(
      prev.run && prev.run.id === event.runId && prev.run.status !== "waiting_input",
    );
    const activeRunChanged = prev.activeRuns?.some(
      (candidate) => candidate.id === event.runId && candidate.status !== "waiting_input",
    );
    const members = updateMemberStatus(prev.members, event.botId, "waiting_input");
    if (!runChanged && !activeRunChanged && members === prev.members) return prev;
    return {
      ...prev,
      cursor: event.seq,
      members,
      run: runChanged && prev.run ? { ...prev.run, status: "waiting_input" } : prev.run,
      activeRuns: activeRunChanged
        ? prev.activeRuns?.map((candidate) =>
            candidate.id === event.runId ? { ...candidate, status: "waiting_input" } : candidate,
          )
        : prev.activeRuns,
    };
  }
  if (isRunTerminalEvent(event)) {
    const activeRuns = prev.activeRuns?.filter((candidate) => candidate.id !== event.runId);
    const nextMemberRun = activeRuns?.find((candidate) => candidate.botId === event.botId);
    return {
      ...prev,
      cursor: event.seq,
      messages: prev.messages.filter((message) => message.id !== progressMessageId(event)),
      members: updateMemberStatus(prev.members, event.botId, nextMemberRun?.status ?? "idle"),
      run: prev.run?.id === event.runId ? (activeRuns?.[0] ?? null) : prev.run,
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
      createdAt: event.createdAt,
    };
    const replacedSubagentIds = new Set(
      blocks.filter((block) => block.kind === "subagent").map((block) => block.agentId),
    );
    const liveId = progressMessageId(event);
    const { remaining } = takeLiveMessage(prev.messages, liveId);
    const without = remaining.filter(
      (message) => message.id !== next.id && !replacedSubagent(message, replacedSubagentIds),
    );
    return { ...prev, cursor: event.seq, messages: [...without, next] };
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

export function computerPanelAutoBoot(
  state: ComputerStatus["state"] | undefined,
  screenUrl?: string | null,
): "boot" | "recover-screen" | "wait" {
  if (state === "booting" || state === "suspended") return "wait";
  if (state === "running") return screenUrl ? "wait" : "recover-screen";
  return "boot";
}

export function reduceComputerStatus(
  prev: ComputerStatus | null,
  event: ProductEvent,
): ComputerStatus | null {
  if (!prev) return prev;
  if (!isComputerStatusEvent(event)) return prev;
  if (event.type === "computer.takeover.granted") {
    const takeoverRequested = event.payload.takeoverRequested === true;
    return prev.controlHolder === "user" &&
      prev.controlBotId === event.botId &&
      prev.takeoverRequested === takeoverRequested
      ? prev
      : { ...prev, controlHolder: "user", controlBotId: event.botId, takeoverRequested };
  }
  if (event.type === "computer.takeover.released") {
    const holder = event.payload.holder;
    if (holder !== "bot" && holder !== "none") return prev;
    return prev.controlHolder === holder && prev.controlBotId === null && !prev.takeoverRequested
      ? prev
      : { ...prev, controlHolder: holder, controlBotId: null, takeoverRequested: false };
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
