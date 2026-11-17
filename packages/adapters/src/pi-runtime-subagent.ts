import { clipToolResultText } from "./pi-runtime-limits.js";

export const MAX_PARALLEL_SUBAGENTS = 4;

/**
 * A helper's result within `limit` characters. A stop text (the spent-budget message or a
 * terminating reply) stays whole when it fits and only the narration before it is shortened;
 * clipped text ends with "…" and never goes past the limit.
 */
export function helperResultText(text: string, tail: string | undefined, limit: number): string {
  const clipTo = (value: string, max: number) =>
    value.length > max ? clipToolResultText(value, Math.max(0, max - 1)) : value;
  if (!tail) return clipTo(text, limit);
  if (tail.length > limit) return clipTo(tail, limit);
  const room = limit - tail.length - 2;
  return text && room > 1 ? `${clipTo(text, room)}\n\n${tail}` : tail;
}
