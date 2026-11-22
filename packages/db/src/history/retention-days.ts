/** About a century: far enough to mean never, and well inside the range of a date. */
export const MAX_RETENTION_DAYS = 36_500;

/**
 * Reads a retention setting as a whole number of days, or `fallback` when it is unset or blank.
 * A value that is set but is not a whole number of days from 1 to 36,500 is an error, so a typo
 * never shortens or silently stops pruning while the operator believes otherwise.
 */
export function parseRetentionDays<T extends number | null>(
  name: string,
  raw: string | undefined,
  fallback: T,
): number | T {
  const text = raw?.trim();
  if (!text) return fallback;
  const days = /^\d+$/.test(text) ? Number(text) : 0;
  if (days < 1 || days > MAX_RETENTION_DAYS)
    throw new Error(`${name} must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}`);
  return days;
}
