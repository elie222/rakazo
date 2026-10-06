import type { Report } from "./contracts.js";
import { extractJsonBlock, parseReport } from "./contracts.js";
import { hasHighSeverity } from "./orchestrator.js";
import { buildEscalationUser, P4_COPY_REPAIR } from "./prompts.js";
import type { PotooRepairKind } from "./routine.js";
import { repairMarker } from "./routine.js";

export const ESCALATION_NONCE_PREFIX = "potoo:escalation:";
export const REPAIR_NONCE_PREFIX = "potoo:repair:";

export function escalationClientNonce(patrolRunId: string): string {
  return `${ESCALATION_NONCE_PREFIX}${patrolRunId}`;
}

export function repairClientNonce(originalRunId: string): string {
  return `${REPAIR_NONCE_PREFIX}${originalRunId}`;
}

export type TranscriptEvent = {
  type: string;
  payload: unknown;
};

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
}

/** Pull readable text out of persisted message blocks. Defensive: unknown kinds are skipped. */
export function extractReportText(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const parts: string[] = [];
  for (const block of blocks) {
    const text = stringField(block, "text");
    if (text) parts.push(text);
  }
  const joined = parts.join("\n").trim();
  return joined ? joined : null;
}

/** Render redacted tool audit events as the escalation transcript. Never contains secrets. */
export function formatToolTranscript(events: TranscriptEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "agent.tool.called") {
      const name = stringField(event.payload, "name") ?? "?";
      const executionId = stringField(event.payload, "executionId") ?? "?";
      lines.push(`call ${name} (${executionId})`);
    } else if (event.type === "agent.tool.completed") {
      const record =
        typeof event.payload === "object" && event.payload !== null
          ? (event.payload as Record<string, unknown>)
          : {};
      const name = typeof record.name === "string" ? record.name : "?";
      const outcome = typeof record.outcome === "string" ? record.outcome : "?";
      const durationMs = typeof record.durationMs === "number" ? record.durationMs : "?";
      const error = typeof record.error === "string" ? ` error: ${record.error.slice(0, 300)}` : "";
      lines.push(`done ${name} outcome=${outcome} ${String(durationMs)}ms${error}`);
    } else if (event.type === "thread.subagent") {
      const task = stringField(event.payload, "task") ?? "?";
      const status = stringField(event.payload, "status") ?? "?";
      const result = stringField(event.payload, "result");
      lines.push(
        `subagent ${status}: ${task.slice(0, 200)}${result ? ` -> ${result.slice(0, 500)}` : ""}`,
      );
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(no tool calls recorded)";
}

export function buildEscalationTaskPrompt(patrolJson: string, transcript: string): string {
  return buildEscalationUser(patrolJson, transcript);
}

/**
 * Build the single copy-repair task prompt. The original reply rides
 * along because repair flights run isolated from thread history — without
 * it the model could only file an empty quiet-night and lose findings.
 * The kind marker restores the original flight's temperature.
 */
export function buildRepairTaskPrompt(kind: PotooRepairKind, originalReply: string): string {
  return `${P4_COPY_REPAIR}\n\n${repairMarker(kind)}\n\nYour original reply:\n\n${originalReply.trim()}`;
}

/** Gate: parse the patrol's final text and return the report only when it carries high severity. */
export function shouldEscalate(finalText: string): Report | null {
  const report = parseReport(finalText);
  if (!report || !hasHighSeverity(report)) return null;
  return report;
}

export function extractPatrolJson(messageText: string): string | null {
  return extractJsonBlock(messageText);
}
