import { createHash } from "node:crypto";
import type { ToolCallStreak } from "@rakazo/core";
import { trackToolCallStreak } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { toolResultError } from "./tool-result-error.js";

const LOOP_GUARD_STOP_PREFIX = "I got stuck calling ";
const LOOP_GUARD_STOP_COUNT_PATTERN =
  " with (?:(?:nearly )?the same input|the same result|too many actions) ";
const LOOP_GUARD_STOP_SUFFIX =
  " times in a row without making progress, so I stopped early. Try rephrasing this, or ask me to try a different approach.";
const LOOP_GUARD_STOP_PATTERN = new RegExp(
  `^${LOOP_GUARD_STOP_PREFIX}.+${LOOP_GUARD_STOP_COUNT_PATTERN}\\d+${LOOP_GUARD_STOP_SUFFIX.replaceAll(".", "\\.")}$`,
);

/**
 * Which run stopped the loop and the count its stop message gives: one call repeated exactly,
 * calls that differ only by digits, or one tool whose answer stayed the same whatever its input.
 */
export function loopGuardStop(streak: LoopGuardStreak): {
  kind: "identical" | "similar" | "same_result";
  count: number;
} {
  const shapeCount = streak.shapeCount ?? 0;
  const failed = (streak.failures ?? 0) >= MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS - 1;
  if (!failed && shapeCount < MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS)
    return { kind: "same_result", count: streak.sameResultCount ?? 0 };
  // Short of the similar limit, only a repeated failure stops a run, and that is an identical one.
  return streak.count >= MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS ||
    shapeCount < MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS
    ? { kind: "identical", count: streak.count }
    : { kind: "similar", count: toolCallStreakLength(streak) };
}

const LOOP_GUARD_STOP_REPEATS = {
  identical: "the same input",
  similar: "nearly the same input",
  same_result: "the same result",
};

export function loopGuardStopText(toolName: string, streak: LoopGuardStreak): string {
  const { kind, count } = loopGuardStop(streak);
  return `${LOOP_GUARD_STOP_PREFIX}${toolName} with ${LOOP_GUARD_STOP_REPEATS[kind]} ${count}${LOOP_GUARD_STOP_SUFFIX}`;
}

export function overLimitStopText(toolName: string, count: number): string {
  return `${LOOP_GUARD_STOP_PREFIX}${toolName} with too many actions ${count}${LOOP_GUARD_STOP_SUFFIX}`;
}

export function isLoopGuardStopText(text: string): boolean {
  return LOOP_GUARD_STOP_PATTERN.test(text);
}

// Same tool, same arguments, failing this many times in a row means the agent is stuck.
const MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 6;
// Arguments that differ only by digits in their text (`echo noop-1`, `echo noop-2`) can be a real
// sequence such as reading a file in chunks or paging through a site, so they get more room. So
// does an identical call that keeps succeeding with the same answer: it may be waiting on a page,
// and one tool that keeps getting the same answer whatever its input.
const MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS = 25;
const FAILED_RESULT = "failed:";

// A batch over the action limit is refused unrun. Sending another one is a loop the model rarely
// leaves on its own, so it is told on the repeat and the run ends on this one.
export const MAX_CONSECUTIVE_OVER_LIMIT_ACTION_CALLS = 4;
/** The most actions one `computer_act` or `browser_act` call may carry. */
export const MAX_ACTIONS_PER_CALL = 24;

/** A double click expands to two computer actions; every other action stays as one. */
export function computerActionCount(action: unknown): number {
  if (!action || typeof action !== "object") return 1;
  const { kind, double } = action as { kind?: unknown; double?: unknown };
  return kind === "click" && double === true ? 2 : 1;
}

/** Counts consecutive over-limit `computer_act`/`browser_act` batches; other calls leave it alone. */
export function advanceOverLimitActionCalls(count: number, name: string, args: unknown): number {
  if (name !== "computer_act" && name !== "browser_act") return count;
  const actions = (args as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) return 0;
  const actionCount =
    name === "computer_act"
      ? actions.reduce((total, action) => total + computerActionCount(action), 0)
      : actions.length;
  return actionCount > MAX_ACTIONS_PER_CALL ? count + 1 : 0;
}

/** The longer of the two runs, for the stop message. */
export function toolCallStreakLength(streak: ToolCallStreak): number {
  return Math.max(streak.count, streak.shapeCount ?? 0);
}

/**
 * `executionId`, `name` and `response` are the streak's last call, its tool and the model response
 * that made it; `results` are the distinct answers this identical run has had, up to the similar
 * limit, and `failures` how many answers in a row failed. `sameResultCount` counts the model
 * responses in a row that called only `name` and got `sameResult` back, whatever the input.
 */
export type LoopGuardStreak = ToolCallStreak & {
  executionId?: string;
  name?: string;
  response?: number;
  results?: string[];
  failures?: number;
  sameResult?: string;
  sameResultCount?: number;
};

/**
 * What the model saw: content rather than details, which can carry timings. Failures are marked
 * so a repeat of one stops sooner.
 */
export function toolResultFingerprint(result: unknown, error?: unknown): string {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  // Screen results compare by frame: their text carries the capture time.
  const frameId = (record.details as { frameId?: unknown } | undefined)?.frameId;
  const seen =
    error !== undefined
      ? error instanceof Error
        ? error.message
        : String(error)
      : typeof frameId === "string"
        ? frameId
        : "content" in record
          ? record.content
          : result;
  const failed = error !== undefined || toolResultError(result) !== undefined;
  return `${failed ? FAILED_RESULT : ""}${createHash("sha256")
    .update(JSON.stringify(seen) ?? "")
    .digest("hex")}`;
}

/**
 * `previousResult` is the fingerprint of the streak's last call, once it has finished. A repeat
 * whose last answer is new to the run is polling something that changes, so the identical run
 * starts over from that call; answers it has seen before (a blinking cursor) keep counting. A
 * repeat stops early only when its answers keep failing. Matching calls from one model response
 * are one step, so they return the streak unchanged, and calls of one tool from one response are
 * one step of its same-result run.
 */
export function advanceToolCallLoopGuard(
  streak: LoopGuardStreak,
  name: string,
  args: unknown,
  previousResult?: string,
  response?: number,
): { streak: LoopGuardStreak; stuck: boolean } {
  // Preserve JSON's optional-field handling, then compare objects independently of field order.
  const serialized = JSON.stringify(args);
  const canonicalArgs =
    serialized === undefined ? undefined : JSON.parse(stableJsonValue(JSON.parse(serialized)));
  let next = trackToolCallStreak(streak, name, canonicalArgs);
  if (response !== undefined && response === streak.response && next.shape === streak.shape)
    return { streak, stuck: false };
  const same = next.key === streak.key;
  const seen = (same && streak.results) || [];
  const fresh = previousResult !== undefined && !seen.includes(previousResult);
  const restart = same && fresh && seen.length > 0;
  if (restart)
    next = trackToolCallStreak({ ...streak, count: 1, shapeCount: 1 }, name, canonicalArgs);
  const results = fresh
    ? [...seen, previousResult].slice(-MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS)
    : seen;
  const failures =
    same && previousResult?.startsWith(FAILED_RESULT)
      ? (restart ? 0 : (streak.failures ?? 0)) + 1
      : 0;
  const sameStep = response !== undefined && response === streak.response && name === streak.name;
  const sameResult = sameStep
    ? { sameResult: streak.sameResult, sameResultCount: streak.sameResultCount }
    : sameResultRun(streak, name, previousResult);
  return {
    streak: { ...next, name, response, ...(same ? { results, failures } : {}), ...sameResult },
    // The first call has no answer yet, so six identical failing calls have five failures.
    stuck:
      failures >= MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS - 1 ||
      (next.shapeCount ?? 0) >= MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS ||
      (sameResult.sameResultCount ?? 0) >= MAX_CONSECUTIVE_SIMILAR_TOOL_CALLS,
  };
}

/** The same-result run after a new step: another tool or an unknown answer starts it over. */
function sameResultRun(streak: LoopGuardStreak, name: string, previousResult?: string) {
  if (name !== streak.name || previousResult === undefined) return { sameResultCount: 1 };
  // The previous step's answer is known now, so the run holds it and this call.
  if (streak.sameResult !== undefined && streak.sameResult !== previousResult)
    return { sameResult: previousResult, sameResultCount: 2 };
  return { sameResult: previousResult, sameResultCount: (streak.sameResultCount ?? 0) + 1 };
}
