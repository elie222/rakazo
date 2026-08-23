import { createHash } from "node:crypto";

function invalidJsonValue(): never {
  throw new TypeError("Approval arguments must contain only JSON values");
}

export function stableJsonValue(value: unknown): string {
  const ancestors = new WeakSet<object>();

  function serialize(current: unknown): string {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? JSON.stringify(current) : invalidJsonValue();
    }
    if (typeof current !== "object") return invalidJsonValue();
    if (ancestors.has(current)) return invalidJsonValue();

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const items: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!(index in current)) return invalidJsonValue();
          items.push(serialize(current[index]));
        }
        return `[${items.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return invalidJsonValue();
      const object = current as Record<string, unknown>;
      const entries = Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`);
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  }

  return serialize(value);
}

export function approvalEffectKey(
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const digest = createHash("sha256").update(stableJsonValue(args)).digest("hex");
  return `${runId}:${toolName}:${digest}`;
}
