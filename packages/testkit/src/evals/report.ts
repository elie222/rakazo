import type { Criterion } from "./cases.js";
import type { DiagnosticToolObservation, HistoryDiagnostic } from "./history-observer.js";
import type { CacheDecisionMeasurement, Operation } from "./measurement.js";
import { OPERATION_KINDS, summarizeCacheDecisions } from "./measurement.js";
import type { measureWorkflowSteps } from "./step-accounting.js";
import type { DiagnosticWireObservation } from "./wire-observer.js";

export type FailureCategory = "agent" | "product" | "provider" | "harness" | "incomplete";
export type TrialResult = {
  caseId: string;
  trial: number;
  strategy?: string;
  stepAccounting?: ReturnType<typeof measureWorkflowSteps>;
  cacheDecisions?: CacheDecisionMeasurement[];
  historyDiagnostics?: HistoryDiagnostic[];
  toolLoopDiagnostics?: DiagnosticToolObservation[];
  wireDiagnostics?: DiagnosticWireObservation[];
  backgroundFailures?: Record<string, number>;
  historyPreparationState?: {
    beforeCursor: number | null;
    afterCursor: number | null;
    remainingMessages: number;
    summaryPresent: boolean;
    generation: number;
  };
  status: "passed" | "failed" | "not-run";
  category: FailureCategory | null;
  reason: string | null;
  criteria: Criterion[];
  assisted: false;
  cleanupFailed: boolean;
  latencyMs: number;
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costSources: string[];
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  modelCalls: number;
  cacheHitRate: number | null;
  firstResponseMs: number | null;
  operationCosts: Record<Operation, number | null>;
  trace: Array<{ step: number; status: string; tools: string[] }>;
  artifacts: Record<string, string | null>;
};

export function summarize(results: readonly TrialResult[]) {
  return [...new Set(results.map((r) => JSON.stringify([r.caseId, r.strategy])))].map((key) => {
    const [caseId, strategy] = JSON.parse(key) as [string, string | undefined];
    const trials = results.filter(
      (r) => r.caseId === caseId && (r.strategy ?? null) === (strategy ?? null),
    );
    const attempted = trials.filter((r) => r.status !== "not-run");
    const passed = trials.filter((r) => r.status === "passed").length;
    return {
      caseId,
      ...(strategy ? { strategy } : {}),
      cacheTelemetry: summarizeCacheDecisions(
        attempted.flatMap((r) => r.cacheDecisions ?? []),
        attempted.reduce((n, r) => n + r.modelCalls, 0),
      ),
      modelCalls: attempted.reduce((n, r) => n + r.modelCalls, 0),
      costSources: [...new Set(attempted.flatMap((r) => r.costSources ?? []))],
      costUsd:
        attempted.length && attempted.every((r) => r.costUsd !== null)
          ? attempted.reduce((n, r) => n + r.costUsd!, 0)
          : null,
      inputTokens:
        attempted.length && attempted.every((r) => r.inputTokens !== null)
          ? attempted.reduce((n, r) => n + r.inputTokens!, 0)
          : null,
      outputTokens:
        attempted.length && attempted.every((r) => r.outputTokens !== null)
          ? attempted.reduce((n, r) => n + r.outputTokens!, 0)
          : null,
      cacheReadTokens: sumMeasured(attempted, "cacheReadTokens"),
      cacheWriteTokens: sumMeasured(attempted, "cacheWriteTokens"),
      cacheWrite1hTokens: sumMeasured(attempted, "cacheWrite1hTokens"),
      reasoningTokens: sumMeasured(attempted, "reasoningTokens"),
      totalTokens: sumMeasured(attempted, "totalTokens"),
      meanFirstResponseMs:
        attempted.length && attempted.every((r) => r.firstResponseMs !== null)
          ? attempted.reduce((n, r) => n + r.firstResponseMs!, 0) / attempted.length
          : null,
      latencyP50Ms: percentile(
        attempted.map((r) => r.latencyMs),
        0.5,
      ),
      latencyP95Ms: percentile(
        attempted.map((r) => r.latencyMs),
        0.95,
      ),
      operationCosts: Object.fromEntries(
        OPERATION_KINDS.map((kind) => {
          const values = attempted.map((r) => r.operationCosts[kind]);
          return [
            kind,
            values.length && values.every((v) => v !== null)
              ? values.reduce<number>((n, v) => n + v!, 0)
              : null,
          ];
        }),
      ),
      planned: trials.length,
      attempted: attempted.length,
      passed,
      failed: trials.filter((r) => r.status === "failed").length,
      notRun: trials.filter((r) => r.status === "not-run").length,
      firstAttemptPassed: trials.find((r) => r.trial === 1)?.status === "passed",
      autonomousSuccessRate: attempted.length ? passed / attempted.length : null,
      meanLatencyMs: attempted.length
        ? Math.round(attempted.reduce((n, r) => n + r.latencyMs, 0) / attempted.length)
        : null,
    };
  });
}

/** Report content comes from synthetic fixtures, but model output is still untrusted. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let safe = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    safe = safe.replaceAll(secret, "[redacted]");
  return safe
    .replace(/(?:https?|postgres(?:ql)?):\/\/[^\s<>"']+/gi, "[url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(?:\/Users\/|\/home\/)[^\s"']+/g, "[local-path]")
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret|authorization)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:(?:bearer|basic|token)\s+)?[^\s"',;&]+)/gi,
      "$1[redacted]",
    );
}

export function emptyTrial(caseId: string, trial: number): TrialResult {
  return {
    caseId,
    trial,
    status: "not-run",
    category: "incomplete",
    reason: "Not started",
    criteria: [],
    assisted: false,
    cleanupFailed: false,
    latencyMs: 0,
    toolCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costSources: [],
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheWrite1hTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    modelCalls: 0,
    cacheHitRate: null,
    firstResponseMs: null,
    operationCosts: {
      answer: null,
      setup: null,
      retrieval: null,
      subagent: null,
      compaction: null,
    },
    trace: [],
    artifacts: {},
  };
}

export function validateControls(input: {
  trials: number;
  timeoutMs: number;
  maxToolCalls: number;
}) {
  for (const [name, value, max] of [
    ["trials", input.trials, 20],
    ["timeoutMs", input.timeoutMs, 900_000],
    ["maxToolCalls", input.maxToolCalls, 100],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
}

function sumMeasured(
  rows: readonly TrialResult[],
  key:
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "cacheWrite1hTokens"
    | "reasoningTokens"
    | "totalTokens",
) {
  return rows.length && rows.every((r) => r[key] !== null)
    ? rows.reduce((n, r) => n + r[key]!, 0)
    : null;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(values.length * p) - 1)]!;
}
