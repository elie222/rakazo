import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = new URL("../prisma/migrations/", import.meta.url);

describe("pending capture index migration", () => {
  it("indexes only pending captures in due/id order without blocking writes for the build", () => {
    const sql = readFileSync(
      new URL("20261206120000_pending_capture_index/migration.sql", migrationsDir),
      "utf8",
    );
    const statements = sql
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((statement) => statement.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    expect(statements).toEqual([
      'CREATE INDEX CONCURRENTLY "runs_pending_memory_capture_idx" ON "runs" ("memoryCaptureDueAt", "id") WHERE "memoryCaptureDueAt" IS NOT NULL AND "memoryCapturedAt" IS NULL',
    ]);
  });

  it("preserves the checksum of the already-applied capture migration", () => {
    const bytes = readFileSync(
      fileURLToPath(new URL("20261201120000_turn_memory_capture/migration.sql", migrationsDir)),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "1e384c600b8a3688e60f7b5096015ca01e8e535ca469a180429645d914ea2bed",
    );
  });
});
