import * as z from "zod";

export const PAGE_STATE_MAX_BYTES = 64 * 1024;
export const PAGE_STATE_MAX_KEYS = 100;
const PAGE_STATE_MAX_DEPTH = 6;
export const PAGE_STATE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

function pageStateValue(value: unknown, depth = 1): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > PAGE_STATE_MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => pageStateValue(item, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return false;
  return Object.values(value).every((item) => pageStateValue(item, depth + 1));
}

export function pageStateBytes(values: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(values)).byteLength;
}

export const PageStateSchema = z
  .record(z.string().regex(PAGE_STATE_KEY), z.unknown())
  .refine((values) => Object.keys(values).length <= PAGE_STATE_MAX_KEYS, {
    message: `A page saves at most ${PAGE_STATE_MAX_KEYS} values for each reader`,
    abort: true,
  })
  .refine((values) => Object.values(values).every((value) => pageStateValue(value)), {
    message: "Saved page values must be plain JSON",
    abort: true,
  })
  .refine((values) => pageStateBytes(values) <= PAGE_STATE_MAX_BYTES, {
    message: `A page saves at most ${PAGE_STATE_MAX_BYTES / 1024} KB for each reader`,
  });
export type PageState = Record<string, unknown>;
