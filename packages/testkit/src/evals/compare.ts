import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { TrialResult } from "./report.js";

type TrialOrigin = NonNullable<TrialResult["origin"]>["kind"];
type Trial = Pick<TrialResult, "caseId" | "trial" | "status"> & {
  strategy: string;
  origin?: TrialOrigin;
};

async function main(args: string[]) {
  const paths = args[0] === "--" ? args.slice(1) : args;
  const [baselinePath, candidatePath] = paths;
  if (paths.length !== 2 || !baselinePath || !candidatePath) {
    throw new Error("Usage: pnpm test:evals:compare <baseline.json> <candidate.json>");
  }

  const [baseline, candidate] = await Promise.all([
    readReport(baselinePath, "Baseline"),
    readReport(candidatePath, "Candidate"),
  ]);
  const differences = Object.entries(baseline.configuration)
    .filter(([key, value]) => !isDeepStrictEqual(value, candidate.configuration[key]))
    .map(([key]) => key);
  if (
    baseline.trials.size !== candidate.trials.size ||
    [...baseline.trials.keys()].some((key) => !candidate.trials.has(key))
  ) {
    differences.push("planned trials");
  }
  if (differences.length) {
    throw new Error(`Reports cannot be directly compared. Differences: ${differences.join(", ")}.`);
  }

  const regressions: string[] = [];
  const candidateNotRun: string[] = [];
  for (const [key, trial] of candidate.trials) {
    const baselineTrial = baseline.trials.get(key);
    if (trial.status === "failed" && baselineTrial?.status === "passed") {
      const provenance = [
        baselineTrial.origin && `baseline ${baselineTrial.origin}`,
        trial.origin && `candidate ${trial.origin}`,
      ].filter(Boolean);
      const origins = provenance.length ? ` [${provenance.join(", ")}]` : "";
      regressions.push(formatTrial(trial) + origins);
    }
    if (trial.status === "not-run") candidateNotRun.push(formatTrial(trial));
  }

  const baselineNotRun = [...baseline.trials.values()]
    .filter(({ status }) => status === "not-run")
    .map(formatTrial);
  printTrials("Regressions (passed -> failed):", regressions);
  printTrials("Not run in candidate:", candidateNotRun);
  if (baselineNotRun.length) printTrials("Not run in baseline:", baselineNotRun);
  console.log(
    `Workflow cost (USD): ${baseline.costUsd ?? "unknown"} -> ${candidate.costUsd ?? "unknown"}`,
  );
}

async function readReport(path: string, label: string) {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`${label} report could not be read.`);
  }
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error(`${label} report is not valid JSON.`);
  }
  if (!isRecord(report) || report.version !== 2 || report.kind !== "real-model-product-eval") {
    throw new Error(`${label} report must be a version 2 real-model-product-eval report.`);
  }

  const { fixtureVersion, caseFixtureVersions, controls, strategies, model, provider, suite } =
    report;
  // Reports from before the reply-mode option always ran in chat mode.
  const replyMode = report.replyMode ?? "chat";
  if (
    typeof fixtureVersion !== "string" ||
    !isRecord(caseFixtureVersions) ||
    !Object.values(caseFixtureVersions).every((version) => typeof version === "string") ||
    !isRecord(controls) ||
    !isPositiveInteger(controls.trials) ||
    !isPositiveInteger(controls.timeoutMs) ||
    !isPositiveInteger(controls.maxToolCalls) ||
    !Array.isArray(strategies) ||
    strategies.length === 0 ||
    !strategies.every((strategy) => typeof strategy === "string") ||
    !isNullableString(model) ||
    !isNullableString(provider) ||
    (suite !== undefined && typeof suite !== "string") ||
    (replyMode !== "chat" && replyMode !== "messages")
  ) {
    throw new Error(`${label} report has invalid experiment configuration.`);
  }

  const judge = report.judge ?? null;
  if (
    judge !== null &&
    (!isRecord(judge) ||
      typeof judge.provider !== "string" ||
      typeof judge.model !== "string" ||
      typeof judge.rubricVersion !== "string")
  ) {
    throw new Error(`${label} report has invalid judge configuration.`);
  }
  const configuration: Record<string, unknown> = {
    suite,
    fixtureVersion,
    caseFixtureVersions,
    "controls.trials": controls.trials,
    "controls.timeoutMs": controls.timeoutMs,
    "controls.maxToolCalls": controls.maxToolCalls,
    strategies,
    model,
    provider,
    replyMode,
    modelLimits: report.modelLimits,
    executionOrder: report.executionOrder,
    promptOrder: report.promptOrder,
    historyPreparation: report.historyPreparation,
    cacheCapabilities: report.cacheCapabilities ?? null,
    assistedRetries: report.assistedRetries,
    spendCapUsd: report.spendCapUsd,
    pricing: report.pricing,
    judge: judge && {
      provider: judge.provider,
      model: judge.model,
      rubricVersion: judge.rubricVersion,
      pricing: judge.pricing,
    },
  };

  if (!Array.isArray(report.trials) || report.trials.length === 0) {
    throw new Error(`${label} report has no planned trials.`);
  }
  const trials = new Map<string, Trial>();
  for (const trial of report.trials as unknown[]) {
    if (
      !isRecord(trial) ||
      typeof trial.caseId !== "string" ||
      !Object.hasOwn(caseFixtureVersions, trial.caseId) ||
      typeof trial.strategy !== "string" ||
      !strategies.includes(trial.strategy) ||
      !isPositiveInteger(trial.trial) ||
      trial.trial > controls.trials ||
      (trial.status !== "passed" && trial.status !== "failed" && trial.status !== "not-run")
    ) {
      throw new Error(`${label} report has an invalid trial.`);
    }
    const origin = isRecord(trial.origin) ? trial.origin.kind : undefined;
    const key = JSON.stringify([trial.caseId, trial.strategy, trial.trial]);
    if (trials.has(key)) throw new Error(`${label} report has a duplicate trial.`);
    trials.set(key, {
      caseId: trial.caseId,
      strategy: trial.strategy,
      trial: trial.trial,
      status: trial.status,
      ...(origin === "reused" || origin === "regraded" ? { origin } : {}),
    });
  }

  const costUsd = isRecord(report.workflowTotals) ? (report.workflowTotals.costUsd ?? null) : null;
  if (
    costUsd !== null &&
    (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0)
  ) {
    throw new Error(`${label} report has an invalid workflow cost.`);
  }
  return { configuration, trials, costUsd };
}

function formatTrial({ caseId, strategy, trial }: Trial) {
  return `- ${caseId} (strategy: ${strategy}, trial: ${trial})`.replace(/[\p{Cc}\p{Cf}]/gu, "");
}

function printTrials(heading: string, trials: string[]) {
  console.log(heading);
  if (!trials.length) console.log("  None");
  for (const line of trials) console.log(line);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

await main(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
