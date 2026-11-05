import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const operations = new URL("../prisma/operations/turn-memory-capture/", import.meta.url);
const withoutComments = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();

describe("capture adoption operator commands", () => {
  it("commits bounded additive DDL before a separate, sole concurrent legacy-index command", () => {
    expect(withoutComments(readFileSync(new URL("columns.sql", operations), "utf8"))).toBe(
      'BEGIN; SET LOCAL lock_timeout = \'2s\'; SET LOCAL statement_timeout = \'10s\'; ALTER TABLE public."runs" ADD COLUMN "memoryCaptureDueAt" TIMESTAMP(3), ADD COLUMN "memoryCapturedAt" TIMESTAMP(3), ADD COLUMN "memoryRecallIds" JSONB; COMMIT;',
    );
    expect(withoutComments(readFileSync(new URL("index.sql", operations), "utf8"))).toBe(
      'CREATE INDEX CONCURRENTLY "runs_memoryCaptureDueAt_memoryCapturedAt_idx" ON public."runs" ("memoryCaptureDueAt", "memoryCapturedAt");',
    );
  });

  it.each([
    { phase: "before", env: {}, reason: "DATABASE_MIGRATION_URL" },
    { phase: "unknown", env: {}, reason: "before|prepared|resolved" },
    {
      phase: "before",
      env: { DATABASE_MIGRATION_URL: "postgresql://owner:fake@invalid/example?schema=other" },
      reason: "public",
    },
    {
      phase: "before",
      env: {
        DATABASE_MIGRATION_URL:
          "postgresql://owner:fake@invalid/example?options=-c%20search_path%3Dother",
      },
      reason: "options",
    },
    {
      phase: "before",
      env: {
        DATABASE_MIGRATION_URL: "postgresql://owner:fake@invalid/example",
        RAKAZO_MIGRATIONS_PATH: "/different",
      },
      reason: "RAKAZO_MIGRATIONS_PATH",
    },
  ])("refuses unsafe CLI configuration before connecting ($reason)", ({ phase, env, reason }) => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules/tsx/dist/cli.mjs"),
        path.join(root, "packages/db/src/cli/validate-capture-adoption.ts"),
        phase,
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).not.toContain("owner:fake");
  });
});
