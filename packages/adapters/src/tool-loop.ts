import type { ToolCallStreak } from "@rakazo/core";
import { trackToolCallStreak } from "@rakazo/core";

const LOOP_GUARD_STOP_PREFIX = "I got stuck calling ";
const LOOP_GUARD_STOP_COUNT_PREFIX = " with the same input ";
const LOOP_GUARD_STOP_SUFFIX =
  " times in a row without making progress, so I stopped early. Try rephrasing this, or ask me to try a different approach.";
const LOOP_GUARD_STOP_PATTERN = new RegExp(
  `^${LOOP_GUARD_STOP_PREFIX}.+${LOOP_GUARD_STOP_COUNT_PREFIX}\\d+${LOOP_GUARD_STOP_SUFFIX.replaceAll(".", "\\.")}$`,
);

export function loopGuardStopText(toolName: string, count: number): string {
  return `${LOOP_GUARD_STOP_PREFIX}${toolName}${LOOP_GUARD_STOP_COUNT_PREFIX}${count}${LOOP_GUARD_STOP_SUFFIX}`;
}

export function isLoopGuardStopText(text: string): boolean {
  return LOOP_GUARD_STOP_PATTERN.test(text);
}

// Same tool, same arguments, this many times in a row means the agent is stuck, not paginating.
const MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 6;

export function advanceToolCallLoopGuard(
  streak: ToolCallStreak,
  name: string,
  args: unknown,
): { streak: ToolCallStreak; stuck: boolean } {
  const next = trackToolCallStreak(streak, name, args);
  return {
    streak: next,
    stuck: next.count >= MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS,
  };
}
