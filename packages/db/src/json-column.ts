import { getLogger } from "@rakazo/logging";
import { z } from "zod";

/** Which stored value a mismatch is about. Never the value itself: columns hold private content. */
export type JsonColumnRow = { table: string; column: string; id: string };

type JsonSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export class JsonColumnMismatchError extends Error {
  constructor(readonly row: JsonColumnRow) {
    super(`Stored ${row.table}.${row.column} of row ${row.id} does not match its schema`);
    this.name = "JsonColumnMismatchError";
  }
}

/** A stored JSON object, for a reader that checks the keys it uses itself. */
export const JsonObject = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);

const WARNED_ROWS_MAX = 1000;
const warnedRows = new Set<string>();

function logJsonColumnOnce(
  level: "warn" | "error",
  message: string,
  row: JsonColumnRow,
  detail?: Record<string, number | string>,
): void {
  const key = `${row.table}.${row.column}:${row.id}`;
  if (warnedRows.has(key)) return;
  if (warnedRows.size >= WARNED_ROWS_MAX) warnedRows.clear();
  warnedRows.add(key);
  getLogger()[level](message, { ...row, ...detail });
}

/** Warns once per row. `detail` is counts only, never the stored value. */
export function warnJsonColumnOnce(
  message: string,
  row: JsonColumnRow,
  detail?: Record<string, number | string>,
): void {
  logJsonColumnOnce("warn", message, row, detail);
}

/**
 * Reports once per row, as an error, a rejected value its reader worked around: the row is left
 * out so the work around it goes on, and someone has to repair it.
 */
export function reportJsonColumnOnce(message: string, row: JsonColumnRow): void {
  logJsonColumnOnce("error", message, row);
}

/**
 * Reads a JSON column through its schema, so a row an older release, a migration or a bug wrote
 * in another shape is handled at the read instead of surfacing later as a missing property.
 *
 * Each reader picks what a mismatch means: `"reject"` throws for a value the code cannot work
 * without, and `{ fallback }` returns the stated default and warns once per row where an old
 * shape is expected and harmless. The fallback is a default to show, not what the row holds:
 * never write it back, and never decide access from it.
 */
export function readJsonColumn<T>(
  schema: JsonSchema<T>,
  value: unknown,
  row: JsonColumnRow,
  onMismatch: "reject" | { fallback: NoInfer<T> },
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (onMismatch === "reject") throw new JsonColumnMismatchError(row);
  warnJsonColumnOnce("Stored JSON column does not match its schema; using the fallback", row);
  return onMismatch.fallback;
}
