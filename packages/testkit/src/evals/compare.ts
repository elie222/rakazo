import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { judgeDifferences } from "./judge-identity.js";

const positiveInteger = z.number().int().positive();
const TrialSchema = z.object({
  caseId: z.string(),
  strategy: z.string(),
  trial: positiveInteger,
  status: z.enum(["passed", "failed", "not-run"]),
  origin: z.object({ kind: z.enum(["reused", "regraded"]) }).optional(),
});
type Trial = z.infer<typeof TrialSchema>;

const ReportSchema = z.looseObject({
  version: z.literal(2),
  kind: z.literal("real-model-product-eval"),
  suite: z.string().optional(),
  fixtureVersion: z.string(),
  caseFixtureVersions: z.record(z.string(), z.string()),
  controls: z.object({
    trials: positiveInteger,
    timeoutMs: positiveInteger,
    maxToolCalls: positiveInteger,
  }),
  strategies: z.array(z.string()).nonempty(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  // Reports from before the reply-mode option always ran in chat mode.
  replyMode: z.enum(["chat", "messages"]).default("chat"),
  cacheCapabilities: z
    .unknown()
    .optional()
    .transform((value) => value ?? null),
  judge: z
    .object({
      provider: z.string(),
      model: z.string(),
      rubricVersion: z.string(),
      pricing: z.unknown(),
      // Reports from before these were recorded leave them unknown.
      settings: z
        .object({
          endpoint: z.string().nullable(),
          maxOutputTokens: positiveInteger.nullable(),
          reasoning: z.boolean().nullable(),
          thinkingLevel: z.string().nullable(),
        })
        .optional(),
    })
    .nullish()
    .transform((judge) => judge ?? null),
  workflowTotals: z
    .looseObject({ costUsd: z.number().nonnegative().nullish() })
    .nullish()
    .transform((totals) => totals?.costUsd ?? null),
  trials: z.array(TrialSchema).nonempty(),
});

/** Recorded settings that must match for an outcome change to mean anything. */
const COMPARED_SETTINGS = [
  "suite",
  "fixtureVersion",
  "caseFixtureVersions",
  "strategies",
  "model",
  "provider",
  "replyMode",
  "modelLimits",
  "executionOrder",
  "promptOrder",
  "historyPreparation",
  "cacheCapabilities",
  "assistedRetries",
  "spendCapUsd",
  "pricing",
] as const;

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
  const differences: string[] = COMPARED_SETTINGS.filter(
    (key) => !isDeepStrictEqual(baseline.report[key], candidate.report[key]),
  );
  const judges = { baseline: baseline.report.judge, candidate: candidate.report.judge };
  // Older reports lack judge settings: noted below rather than refused.
  differences.push(
    ...judgeDifferences(judges.baseline, judges.candidate).filter((d) => d !== "judge.settings"),
  );
  if (
    judges.baseline &&
    judges.candidate &&
    !isDeepStrictEqual(judges.baseline.pricing, judges.candidate.pricing)
  ) {
    differences.push("judge.pricing");
  }
  const unrecordedJudgeSettings = Object.entries(judges)
    .filter(([, judge]) => judge && !judge.settings)
    .map(([label]) => label);
  for (const key of ["trials", "timeoutMs", "maxToolCalls"] as const) {
    if (baseline.report.controls[key] !== candidate.report.controls[key]) {
      differences.push(`controls.${key}`);
    }
  }
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
  for (const [key, trial] of candidate.trials) {
    const before = baseline.trials.get(key);
    if (trial.status !== "failed" || before?.status !== "passed") continue;
    const provenance = [
      before.origin && `baseline ${before.origin.kind}`,
      trial.origin && `candidate ${trial.origin.kind}`,
    ].filter(Boolean);
    regressions.push(formatTrial(trial) + (provenance.length ? ` [${provenance.join(", ")}]` : ""));
  }

  if (unrecordedJudgeSettings.length) {
    console.log(
      `Judge endpoint, output limit and reasoning settings: unknown in ${unrecordedJudgeSettings.join(" and ")}`,
    );
  }
  const baselineNotRun = notRun(baseline.trials);
  printTrials("Regressions (passed -> failed):", regressions);
  printTrials("Not run in candidate:", notRun(candidate.trials));
  if (baselineNotRun.length) printTrials("Not run in baseline:", baselineNotRun);
  const cost = (usd: number | null) => usd ?? "unknown";
  console.log(
    `Workflow cost (USD): ${cost(baseline.report.workflowTotals)} -> ${cost(candidate.report.workflowTotals)}`,
  );
}

async function readReport(path: string, label: string) {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`${label} report could not be read.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${label} report is not valid JSON.`);
  }
  const parsed = ReportSchema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`${label} report is not a valid version 2 Eval report (${fields.join(", ")}).`);
  }

  const trials = new Map<string, Trial>();
  for (const trial of parsed.data.trials) {
    const key = JSON.stringify([trial.caseId, trial.strategy, trial.trial]);
    if (trials.has(key)) throw new Error(`${label} report has a duplicate trial.`);
    trials.set(key, trial);
  }
  return { report: parsed.data, trials };
}

function notRun(trials: Map<string, Trial>) {
  return [...trials.values()].filter(({ status }) => status === "not-run").map(formatTrial);
}

function formatTrial({ caseId, strategy, trial }: Trial) {
  return `- ${caseId} (strategy: ${strategy}, trial: ${trial})`.replace(/[\p{Cc}\p{Cf}]/gu, "");
}

function printTrials(heading: string, trials: string[]) {
  console.log(heading);
  if (!trials.length) console.log("  None");
  for (const line of trials) console.log(line);
}

await main(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
