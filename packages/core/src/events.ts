import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";

export function projectMessages(
  events: Array<{
    seq: number;
    type: string;
    payload: unknown;
    runId?: string | null;
    createdAt: Date | string;
    id: string;
    threadId: string;
    botId?: string | null;
  }>,
): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  type LiveProjection = {
    blocks: MessageBlock[];
    meta: {
      id: string;
      threadId: string;
      seq: number;
      botId?: string;
      runId?: string;
      createdAt: string;
    };
  };
  const liveById = new Map<string, LiveProjection>();
  const liveSubagents = new Map<string, ThreadMessage>();
  const durableSubagents = new Set<string>();
  const liveProjection = (event: (typeof events)[number], createdAt: string): LiveProjection => {
    const id = progressMessageId(event);
    const existing = liveById.get(id);
    if (existing) return existing;
    const projection: LiveProjection = {
      blocks: [],
      meta: {
        id,
        threadId: event.threadId,
        seq: event.seq,
        botId: event.botId ?? undefined,
        runId: event.runId ?? undefined,
        createdAt,
      },
    };
    liveById.set(id, projection);
    return projection;
  };
  const clearLive = (event: (typeof events)[number]) => {
    if (event.runId) liveById.delete(progressMessageId(event));
    else liveById.clear();
  };
  for (const event of events) {
    const payload = asRecord(event.payload);
    const createdAt =
      typeof event.createdAt === "string" ? event.createdAt : event.createdAt.toISOString();
    if (event.type === "thread.message.created") {
      clearLive(event);
      const role = (payload.role as ThreadMessage["role"]) ?? "bot";
      const blocks = (payload.blocks as MessageBlock[]) ?? [];
      for (const block of blocks) {
        if (block.kind === "subagent") {
          durableSubagents.add(block.agentId);
          liveSubagents.delete(block.agentId);
        }
      }
      messages.push({
        id: (payload.messageId as string) ?? event.id,
        threadId: event.threadId,
        seq: event.seq,
        role,
        blocks,
        botId: event.botId ?? undefined,
        runId: event.runId ?? undefined,
        createdAt,
      });
      continue;
    }
    if (event.type === "thread.progress") {
      const live = liveProjection(event, createdAt);
      live.blocks = reduceLiveMessageBlocks(live.blocks, { type: "progress", payload });
      live.meta = {
        ...live.meta,
        seq: event.seq,
        botId: event.botId ?? undefined,
        createdAt,
      };
      continue;
    }
    if (event.type === "agent.tool.called") {
      const live = liveProjection(event, createdAt);
      live.blocks = reduceLiveMessageBlocks(live.blocks, {
        type: "tool",
        name: String(payload.name ?? ""),
      });
      live.meta = {
        ...live.meta,
        seq: event.seq,
        botId: event.botId ?? undefined,
        createdAt,
      };
      continue;
    }
    if (event.type === "thread.cleared") {
      messages.length = 0;
      liveById.clear();
      liveSubagents.clear();
      durableSubagents.clear();
      continue;
    }
    if (event.type === "thread.subagent") {
      const block = subagentBlockFromPayload(payload);
      if (durableSubagents.has(block.agentId)) continue;
      liveSubagents.set(block.agentId, {
        id: `subagent:${block.agentId}`,
        threadId: event.threadId,
        seq: event.seq,
        role: "bot",
        blocks: [block],
        botId: event.botId ?? undefined,
        runId: event.runId ?? undefined,
        createdAt,
      });
      continue;
    }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      clearLive(event);
    }
  }
  for (const live of liveSubagents.values()) messages.push(live);
  for (const live of liveById.values()) {
    if (live.blocks.length > 0) {
      messages.push({
        id: live.meta.id,
        threadId: live.meta.threadId,
        seq: live.meta.seq,
        role: "bot",
        blocks: live.blocks,
        botId: live.meta.botId,
        runId: live.meta.runId,
        createdAt: live.meta.createdAt,
      });
    }
  }
  return messages;
}

export function progressMessageId(event: { runId?: string | null; id?: string }): string {
  return `progress:${event.runId ?? event.id ?? "live"}`;
}

export function isRunTerminalEvent(event: { type: string }): boolean {
  return (
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}

const RUN_FAILURE_ERROR_MAX = 300;

/** Reason a run failed, clamped for display, or null when there is no usable error to show. */
export function runFailureError(event: {
  type: string;
  payload?: Record<string, unknown>;
}): string | null {
  if (event.type !== "run.failed") return null;
  const error = event.payload?.error;
  if (typeof error !== "string" || !error.trim()) return null;
  const message = error.trim();
  // A provider can fail with a stack or a whole response body; the run record keeps the full
  // text while the UI shows a bounded first line.
  return message.length > RUN_FAILURE_ERROR_MAX
    ? `${message.slice(0, RUN_FAILURE_ERROR_MAX)}…`
    : message;
}

export type LiveMessageUpdate =
  | { type: "progress"; payload: Record<string, unknown> | undefined }
  | { type: "tool"; name: string };

export function reduceLiveMessageBlocks(
  blocks: readonly MessageBlock[],
  update: LiveMessageUpdate,
): MessageBlock[] {
  const tail = blocks.at(-1);
  const segments = tail?.kind === "progress" ? blocks.slice(0, -1) : blocks;
  const priorText = liveMessageText(blocks);
  const flushedLength =
    tail?.kind === "progress" ? priorText.length - tail.text.length : priorText.length;
  const tailText =
    update.type === "progress"
      ? progressMessageText(update.payload, priorText).slice(flushedLength)
      : tail?.kind === "progress"
        ? tail.text
        : "";
  const pendingToolNames = [
    ...(tail?.kind === "progress" ? (tail.pendingToolNames ?? []) : []),
    ...(update.type === "tool" ? [update.name] : []),
  ];

  if (pendingToolNames.length > 0 && endsSentence(tailText)) {
    let next = appendTextSegment(segments, tailText);
    for (const name of pendingToolNames) next = appendToolCallSegment(next, name);
    return next;
  }
  if (!tailText) return [...segments];
  return [
    ...segments,
    {
      kind: "progress",
      text: tailText,
      ...(pendingToolNames.length > 0 ? { pendingToolNames } : {}),
    },
  ];
}

function liveMessageText(blocks: readonly MessageBlock[]): string {
  return blocks
    .filter((block) => block.kind === "text" || block.kind === "progress")
    .map((block) => block.text)
    .join("");
}

export type ToolStep = { label: string; count: number };

export function appendToolStep(steps: readonly ToolStep[], toolName: string): ToolStep[] {
  const label = humanizeToolName(toolName);
  const last = steps.at(-1);
  if (last && last.label === label) {
    return [...steps.slice(0, -1), { label, count: last.count + 1 }];
  }
  return [...steps, { label, count: 1 }];
}

export type ToolCallStreak = { key: string | undefined; count: number };

export function trackToolCallStreak(
  streak: ToolCallStreak,
  name: string,
  args: unknown,
): ToolCallStreak {
  const key = `${name}:${JSON.stringify(args)}`;
  return key === streak.key ? { key, count: streak.count + 1 } : { key, count: 1 };
}

export type ToolNameStreak = { name: string | undefined; count: number };

export function trackToolNameStreak(streak: ToolNameStreak, name: string): ToolNameStreak {
  return name === streak.name ? { name, count: streak.count + 1 } : { name, count: 1 };
}

const SENTENCE_END_RE = /[.!?]["'”’)\]]*\s*$/;

/** True once `text` ends at a sentence boundary (or is empty) — safe to flush without cutting a clause. */
export function endsSentence(text: string): boolean {
  return text.trim() === "" || SENTENCE_END_RE.test(text);
}

export function appendTextSegment(segments: readonly MessageBlock[], text: string): MessageBlock[] {
  if (!text) return [...segments];
  const last = segments.at(-1);
  if (last?.kind === "text") {
    return [...segments.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...segments, { kind: "text", text }];
}

export function appendToolCallSegment(
  segments: readonly MessageBlock[],
  toolName: string,
): MessageBlock[] {
  const last = segments.at(-1);
  const priorSteps = last?.kind === "steps" ? last.steps : [];
  const steps = appendToolStep(priorSteps, toolName);
  if (last?.kind === "steps") {
    return [...segments.slice(0, -1), { kind: "steps", steps }];
  }
  return [...segments, { kind: "steps", steps }];
}

export function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  if (!spaced) return name;
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function progressMessageText(
  payload: Record<string, unknown> | undefined,
  previousText = "",
): string {
  return typeof payload?.delta === "string"
    ? previousText + payload.delta
    : String(payload?.text ?? "");
}

export function subagentBlockFromPayload(
  payload: Record<string, unknown>,
): Extract<MessageBlock, { kind: "subagent" }> {
  const status = payload.status;
  return {
    kind: "subagent",
    agentId: String(payload.agentId ?? ""),
    name: String(payload.name ?? "subagent"),
    task: String(payload.task ?? ""),
    status: status === "completed" || status === "failed" ? status : "running",
    progress: payload.progress ? String(payload.progress) : undefined,
    result: payload.result ? String(payload.result) : undefined,
  };
}

export function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce((acc, secret) => {
    if (!secret) return acc;
    return acc.split(secret).join("[redacted]");
  }, value);
}

export function containsSecret(value: unknown, secrets: string[]): boolean {
  const text = JSON.stringify(value);
  return secrets.some((secret) => secret.length > 0 && text.includes(secret));
}

export function createStreamingRedactor(secrets: string[]) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const maxLength = values[0]?.length ?? 0;
  let buffer = "";

  const drain = (final: boolean) => {
    if (values.length === 0) {
      const output = buffer;
      buffer = "";
      return output;
    }
    const safeStartLimit = final ? buffer.length : Math.max(0, buffer.length - maxLength + 1);
    let offset = 0;
    let output = "";
    while (offset < safeStartLimit) {
      const secret = values.find((value) => buffer.startsWith(value, offset));
      if (secret) {
        output += "[redacted]";
        offset += secret.length;
      } else {
        output += buffer[offset];
        offset += 1;
      }
    }
    buffer = buffer.slice(offset);
    return output;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      return drain(false);
    },
    finish() {
      return drain(true);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
