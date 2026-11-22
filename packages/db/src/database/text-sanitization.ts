import {
  isPlainObject,
  sanitizeJsonValue,
  sanitizeUtf16ForJson,
  stripDirectionalControls,
} from "@rakazo/core";
import type { PrismaClient } from "../generated/prisma/client.js";

const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);
const WRITE_KEYS = ["data", "create", "update"] as const;

/**
 * Fields whose value names something a person reads: a bot, a space, a member, a workspace, a
 * page, or the sender label on a chat-app message (`name`, `displayName`, `participantNames`,
 * `fromLabel`, `title`, ...). A directional control in one makes the name draw as another name, so
 * it is dropped from them. Message text and every other value keep their characters:
 * mixed-direction writing uses the marks legitimately, and stored text must stay what was written.
 */
const NAME_KEY = /(names?|label|title)$/i;

/** Copy-on-change: untouched values keep their identity. Dates, bytes, and decimals pass through. */
function sanitizeValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    const repaired = sanitizeUtf16ForJson(value);
    return key !== undefined && NAME_KEY.test(key) ? stripDirectionalControls(repaired) : repaired;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => sanitizeValue(item, key));
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  // Only JSON can carry such a key (Prisma field names cannot); keep colliding keys apart.
  if (keys.some((key) => sanitizeUtf16ForJson(key) !== key)) return sanitizeJsonValue(value);
  return sanitizeEntries(value, keys, key);
}

/** Prisma's `{ set }` and `{ push }` write the field they sit under, so they keep its name. */
const FIELD_OPERATIONS = new Set(["set", "push"]);

function sanitizeEntries(value: Record<string, unknown>, keys: readonly string[], field?: string) {
  let out: Record<string, unknown> | undefined;
  for (const key of keys) {
    if (!(key in value)) continue;
    const next = sanitizeValue(value[key], FIELD_OPERATIONS.has(key) && field ? field : key);
    if (next === value[key]) continue;
    out ??= { ...value };
    out[key] = next;
  }
  return out ?? value;
}

/**
 * Postgres rejects NUL in text columns, and NUL or an unpaired surrogate in json, so one such
 * character in pasted or tool-produced text would fail the whole write. Replace them in every
 * written value. Filters are left alone: they read rows and cannot store anything.
 */
export function sanitizeWriteArgs(operation: string, args: unknown): unknown {
  if (!WRITE_OPERATIONS.has(operation) || !isPlainObject(args)) return args;
  return sanitizeEntries(args, WRITE_KEYS);
}

export function withTextSanitization(prisma: PrismaClient): PrismaClient {
  return prisma.$extends({
    query: {
      $allModels: {
        $allOperations({ operation, args, query }) {
          return query(sanitizeWriteArgs(operation, args) as typeof args);
        },
      },
    },
  }) as unknown as PrismaClient;
}
