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
  }>,
): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  // The live bot message merges narration and tool calls into one bubble, in the order they
  // happened: fullStreamText is the whole model text stream (deltas are relative to it, never
  // reset by a tool call), flushedUpTo marks how much of it is already folded into liveBlocks,
  // and the remainder renders as the still-streaming tail.
  let fullStreamText = "";
  let flushedUpTo = 0;
  let liveBlocks: MessageBlock[] = [];
  // Tool calls that landed mid-sentence wait here until the narration catches up to a sentence
  // boundary, so the step chips never render in the middle of a clause.
  let pendingToolNames: string[] = [];
  let liveMeta: {
    id: string;
    threadId: string;
    seq: number;
    runId?: string;
    createdAt: string;
  } | null = null;
  const liveSubagents = new Map<string, ThreadMessage>();
  const durableSubagents = new Set<string>();
  const resetLive = () => {
    fullStreamText = "";
    flushedUpTo = 0;
    liveBlocks = [];
    pendingToolNames = [];
    liveMeta = null;
  };
  const tryFlushPendingTools = () => {
    if (pendingToolNames.length === 0) return;
    const tailText = fullStreamText.slice(flushedUpTo);
    if (!endsSentence(tailText)) return;
    liveBlocks = appendTextSegment(liveBlocks, tailText);
    flushedUpTo = fullStreamText.length;
    for (const name of pendingToolNames) {
      liveBlocks = appendToolCallSegment(liveBlocks, name);
    }
    pendingToolNames = [];
  };
  for (const event of events) {
    const payload = asRecord(event.payload);
    const createdAt =
      typeof event.createdAt === "string" ? event.createdAt : event.createdAt.toISOString();
    if (event.type === "thread.message.created") {
      resetLive();
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
        runId: event.runId ?? undefined,
        createdAt,
      });
      continue;
    }
    if (event.type === "thread.progress") {
      fullStreamText = progressMessageText(payload, fullStreamText);
      tryFlushPendingTools();
      liveMeta = {
        id: progressMessageId(event),
        threadId: event.threadId,
        seq: event.seq,
        runId: event.runId ?? undefined,
        createdAt,
      };
      continue;
    }
    if (event.type === "agent.tool.called") {
      pendingToolNames.push(String(payload.name ?? ""));
      tryFlushPendingTools();
      liveMeta = {
        id: progressMessageId(event),
        threadId: event.threadId,
        seq: event.seq,
        runId: event.runId ?? undefined,
        createdAt,
      };
      continue;
    }
    if (event.type === "thread.cleared") {
      messages.length = 0;
      streaming = null;
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
      resetLive();
    }
  }
  for (const live of liveSubagents.values()) messages.push(live);
  if (liveMeta) {
    const tailText = fullStreamText.slice(flushedUpTo);
    const blocks = tailText
      ? [...liveBlocks, { kind: "progress" as const, text: tailText }]
      : liveBlocks;
    if (blocks.length > 0) {
      messages.push({
        id: liveMeta.id,
        threadId: liveMeta.threadId,
        seq: liveMeta.seq,
        role: "bot",
        blocks,
        runId: liveMeta.runId,
        createdAt: liveMeta.createdAt,
      });
    }
  }
  return messages;
}

export function progressMessageId(event: { runId?: string | null; id?: string }): string {
  return `progress:${event.runId ?? event.id ?? "live"}`;
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
