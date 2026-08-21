import { createHash } from "node:crypto";

export function stableJsonValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonValue(obj[key])}`).join(",")}}`;
}

export function approvalEffectKey(
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const digest = createHash("sha256").update(stableJsonValue(args)).digest("hex");
  return `${runId}:${toolName}:${digest}`;
}
