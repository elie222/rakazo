import type { Criterion } from "./cases.js";

export type FailureCategory = "agent" | "product" | "provider" | "harness" | "incomplete";
export type TrialResult = {
  caseId: string;
  trial: number;
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
  costUsd: null;
  trace: Array<{ step: number; status: string; tools: string[] }>;
  artifacts: Record<string, string | null>;
};

export function summarize(results: readonly TrialResult[]) {
  return [...new Set(results.map((r) => r.caseId))].map((caseId) => {
    const trials = results.filter((r) => r.caseId === caseId);
    const attempted = trials.filter((r) => r.status !== "not-run");
    const passed = trials.filter((r) => r.status === "passed").length;
    return {
      caseId,
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
      /((?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[=:]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s"',;&]+)/gi,
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
