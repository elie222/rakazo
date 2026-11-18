const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const MAX_AGE_DAYS = 36_500;

/** What the worker's file cleanups are told to do. */
export interface FilesCleanupSettings {
  /** Delete the copies of attachments in computers once they are old enough. */
  attachments: boolean;
  /** Delete the original files people sent in, once they are old enough. */
  received: boolean;
  /** Delete the original files the bots made, once they are old enough. */
  created: boolean;
  maxAgeMs: number;
  /** How often a cleanup looks at the computers. */
  intervalMs: number;
}

function whole(source: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const value = source[name]?.trim();
  if (!value) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < 1 || number > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}`);
  }
  return number;
}

function flag(source: NodeJS.ProcessEnv, name: string): boolean {
  const value = source[name]?.trim();
  if (value && value !== "true" && value !== "false") {
    throw new Error(`${name} must be true or false`);
  }
  return value === "true";
}

/**
 * Reads the cleanup settings, once at startup. Nothing is deleted unless
 * `FILES_CLEANUP_ATTACHMENTS=true` (copies in computers), `FILES_CLEANUP_RECEIVED=true` or
 * `FILES_CLEANUP_CREATED=true` (original files); a value that is not understood stops the start instead of
 * silently deleting nothing, or too much.
 * `FILES_CLEANUP_MAX_AGE_DAYS` (default 31) is how old a file gets before it goes and
 * `FILES_CLEANUP_INTERVAL_HOURS` (default 24) how often the cleanup looks.
 */
export function filesCleanupSettings(source: NodeJS.ProcessEnv): FilesCleanupSettings {
  return {
    attachments: flag(source, "FILES_CLEANUP_ATTACHMENTS"),
    received: flag(source, "FILES_CLEANUP_RECEIVED"),
    created: flag(source, "FILES_CLEANUP_CREATED"),
    maxAgeMs: whole(source, "FILES_CLEANUP_MAX_AGE_DAYS", 31, MAX_AGE_DAYS) * DAY_MS,
    intervalMs: whole(source, "FILES_CLEANUP_INTERVAL_HOURS", 24, 24 * 365) * HOUR_MS,
  };
}
