import { type ToolCallStreak, trackToolCallStreak } from "@rakazo/core";

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
