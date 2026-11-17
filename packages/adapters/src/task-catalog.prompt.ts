/**
 * Guidance injected alongside the catalog tool. Keep this short: the live
 * records returned by task_catalog are the source of truth for names and ids.
 */
export const TASK_CATALOG_GUIDANCE = [
  "Task execution: task_catalog is the source of truth for this bot's open work, routines, skills, and exposed tools; conversation or memory text is not proof that a task exists.",
  "When a request refers to an existing task, routine, skill, or capability, call task_catalog first and use the exact returned id/name.",
  "For an open task, perform the work with the exposed tools, verify the result, then use scratchpad_update or scratchpad_complete. Never mark work done before verification.",
  "For a schedule, provide exactly one timing mode to schedule_create (cron, every+unit, runAt, delayMinutes, or delaySeconds), then call schedule_list and only report success when the routine is present. Change an existing routine with schedule_update, not cancel and recreate, and report the timing it returns.",
  "If a tool returns an error, do not repeat the same tool call with the same arguments. Correct the specific field once as a separate attempt; if that attempt fails, stop and explain the blocker instead of narrating more retries. A different command is not a retry.",
].join("\n");
