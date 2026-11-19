import { getLogger, serializeError } from "@rakazo/logging";
import type { Criterion, EvalCase, Evidence } from "./cases.js";
import type { EvalJudge } from "./judge.js";
import type { FailureCategory, TrialResult } from "./report.js";
import { redact, restoreEvidence } from "./report.js";

export class EvalFailure extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
  }
}

export async function withinDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Background work exceeded trial deadline")),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SEMANTIC_OUTCOME = "semantic-outcome";

type Grading = { judge?: EvalJudge; deadline: number; secrets: readonly string[] };

/** The judge grades meaning only once every deterministic criterion holds. */
export async function judgeOutcome(
  scenario: EvalCase,
  evidence: Evidence,
  result: TrialResult,
  { judge, deadline, secrets }: Grading,
) {
  if (!scenario.judge || !result.criteria.every((c) => c.pass)) return;
  if (!judge) throw new EvalFailure("incomplete", "Semantic grading requires a judge");
  try {
    const judgment = await withinDeadline(
      judge(scenario.judge(evidence), AbortSignal.timeout(Math.max(1, deadline - Date.now()))),
      deadline,
    );
    result.judgment = { pass: judgment.pass, reason: redact(judgment.reason, secrets) };
    result.criteria.push({ id: SEMANTIC_OUTCOME, pass: judgment.pass });
  } catch (error) {
    throw new EvalFailure(
      "incomplete",
      `Judge unavailable: ${error instanceof Error ? error.message : "Unknown judge failure"}`,
    );
  }
}

/** Behaviour recorded without deciding the trial; an ungraded one is unknown, never absent. */
export async function observe(
  scenario: EvalCase,
  evidence: Evidence,
  { judge, deadline, secrets }: Grading,
): Promise<TrialResult["observations"]> {
  if (!scenario.observe) return undefined;
  const observations: NonNullable<TrialResult["observations"]> = {};
  for (const [key, value] of Object.entries(scenario.observe(evidence))) {
    if (typeof value === "boolean") {
      observations[key] = { present: value };
      continue;
    }
    try {
      if (!judge) throw new Error("no judge");
      const judgment = await withinDeadline(
        judge(value, AbortSignal.timeout(Math.max(1, deadline - Date.now()))),
        deadline,
      );
      observations[key] = { present: judgment.pass, reason: redact(judgment.reason, secrets) };
    } catch (error) {
      observations[key] = {
        present: null,
        reason: `Judge unavailable: ${error instanceof Error ? error.message : "Unknown judge failure"}`,
      };
    }
  }
  return observations;
}

/**
 * The trial's verdict from its criteria. A failure after the offline sandbox refused something the
 * bot needed is the harness's, unless the case needs no command at all.
 */
export function settle(scenario: EvalCase, result: TrialResult, harnessIssues: readonly string[]) {
  result.status =
    result.criteria.length > 0 && result.criteria.every((c) => c.pass) ? "passed" : "failed";
  result.category = result.status === "passed" ? null : "agent";
  result.reason = result.status === "passed" ? null : "Outcome criteria failed";
  if (result.status === "failed" && harnessIssues.length) {
    if (scenario.shellUnneeded)
      result.reason = `Outcome criteria failed after the bot chose a command the case does not need: ${harnessIssues.join(" ")}`;
    else {
      result.category = "harness";
      result.reason = harnessIssues.join(" ");
    }
  }
}

/**
 * The deterministic criteria the current case gives a stored trial's evidence, or null when the
 * trial kept none or the case cannot read it (its shape changed since).
 */
function currentCriteria(scenario: EvalCase, trial: TrialResult): Criterion[] | null {
  if (!trial.evidence) return null;
  try {
    return scenario.grade(restoreEvidence(trial.evidence) as Evidence);
  } catch (error) {
    getLogger().warn("A stored eval trial could not be graded by its case; it will be rerun", {
      caseId: scenario.id,
      trial: trial.trial,
      error: serializeError(error),
    });
    return null;
  }
}

/** Whether a stored trial can be graded again: a trial that kept its evidence reached grading. */
export function regradable(scenario: EvalCase, trial: TrialResult) {
  return trial.evidence ? currentCriteria(scenario, trial) !== null : !trial.criteria.length;
}

/** Whether the current case's deterministic criteria give the trial the verdicts it was stored with. */
export function gradedAsStored(scenario: EvalCase, trial: TrialResult) {
  if (!trial.evidence) return true;
  const stored = trial.criteria.filter((c) => c.id !== SEMANTIC_OUTCOME);
  return JSON.stringify(currentCriteria(scenario, trial)) === JSON.stringify(stored);
}

/**
 * A stored trial graded again with the current case and judge, from the evidence it kept, without
 * running the bot. A trial that never reached grading is unchanged.
 */
export async function regradeTrial(
  scenario: EvalCase,
  stored: TrialResult,
  judge: EvalJudge | undefined,
  timeoutMs: number,
): Promise<TrialResult> {
  const result = structuredClone(stored);
  if (!stored.evidence) return result;
  const evidence = restoreEvidence(stored.evidence) as Evidence;
  const grading = { judge, deadline: Date.now() + timeoutMs, secrets: [] };
  result.criteria = scenario.grade(evidence);
  delete result.judgment;
  try {
    await judgeOutcome(scenario, evidence, result, grading);
    settle(scenario, result, stored.harnessIssues ?? []);
  } catch (error) {
    result.status = "failed";
    result.category = error instanceof EvalFailure ? error.category : "harness";
    result.reason = error instanceof Error ? error.message : "Unknown judge failure";
  }
  const observations = await observe(scenario, evidence, grading);
  if (observations) result.observations = observations;
  return result;
}
