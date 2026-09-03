/** Formats a wall-clock duration as compact whole seconds. */
export function formatDurationMs(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours}h` : "", minutes || hours ? `${minutes}m` : "", `${seconds}s`]
    .filter(Boolean)
    .join(" ");
}

export function toolActivityLabel(durationMs: number | undefined, live: boolean): string {
  if (live) return "Working…";
  const duration = formatDurationMs(durationMs);
  return duration ? `Worked for ${duration}` : "Worked";
}
