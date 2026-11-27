import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFERRED_MIGRATION_MARKER } from "./deferred-migrations.js";

const migrationsDir = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));
// Migrations up to this one predate the check; later ones must follow it.
const LAST_UNCHECKED = "20261115120000_billing_byok_price";

// The previous release still reads what these remove while both run during a deploy, so they
// wait for the next deploy behind the deferred marker.
// `COLUMN` is optional in `ALTER TABLE … DROP`; dropping a constraint is fine.
const DROP =
  /\bDROP\s+(?:TABLE|TYPE|VIEW)\b|^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?\S+\s+DROP\s+(?!CONSTRAINT\b)|,\s*DROP\s+(?!CONSTRAINT\b)/i;
// This repository writes DDL through `DO $$ ... EXECUTE format('ALTER TABLE ...') $$`, where the
// statement starts with `DO`, so the patterns above never see the DDL inside the literal.
const DYNAMIC_DDL = /EXECUTE\s+format\(\s*'((?:[^']|'')*)'/gi;
// No marker makes a rename safe: one of the two releases always reads the missing name.
// Renaming a constraint is fine.
const RENAME = /^ALTER\s+TABLE\b.*\bRENAME\s+(?!CONSTRAINT\b)/i;

/** Statements that break the release running alongside this migration during a deploy. */
function unsafeStatements(sql: string): string[] {
  const deferred = sql.startsWith(DEFERRED_MIGRATION_MARKER);
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim().replace(/\s+/g, " "))
    .filter((statement) => {
      // A literal inside a comment, a NOTICE or a COMMENT ON is text, not DDL the deploy runs.
      const code = statement.replace(/'(?:[^']|'')*'/g, "''");
      if (RENAME.test(code)) return true;
      if (deferred) return false;
      if (DROP.test(code)) return true;
      // A template may be indented or wrapped across lines, so it is trimmed before it is read.
      return [...statement.matchAll(DYNAMIC_DDL)].some((match) =>
        DROP.test((match[1] ?? "").trim()),
      );
    });
}

describe("migration safety", () => {
  it("keeps every new migration working with the previous release", () => {
    const offenders = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name > LAST_UNCHECKED)
      .flatMap((entry) =>
        unsafeStatements(
          readFileSync(path.join(migrationsDir, entry.name, "migration.sql"), "utf8"),
        ).map((statement) => `${entry.name}: ${statement}`),
      );
    expect(
      offenders,
      `Drops need "${DEFERRED_MIGRATION_MARKER}" on the first line; renames must add, backfill and drop the old name deferred (AGENTS.md)`,
    ).toEqual([]);
  });

  it("flags undeferred drops and every table or column rename", () => {
    const sql = `
      -- DROP COLUMN in a comment is fine
      ALTER TABLE "bots" DROP COLUMN "title";
      ALTER TABLE "bots" DROP "label";
      ALTER TABLE "bots" DROP /* cleanup */ COLUMN "notes";
      DROP TABLE IF EXISTS "old";
      ALTER TABLE "bots" RENAME COLUMN "a" TO "b";
      ALTER TABLE "bots" RENAME TO "agents";
      ALTER TABLE "bots" DROP CONSTRAINT "bots_pkey";
      ALTER TABLE "bots" RENAME CONSTRAINT "x" TO "y";
      ALTER TABLE "bots" ALTER COLUMN "name" DROP DEFAULT;
      ALTER TABLE "bots" ALTER COLUMN "name" DROP NOT NULL, DROP CONSTRAINT "c";
      DROP INDEX "bots_name_idx";
      ALTER INDEX "a_idx" RENAME TO "b_idx";
    `;
    expect(unsafeStatements(sql)).toEqual([
      'ALTER TABLE "bots" DROP COLUMN "title"',
      'ALTER TABLE "bots" DROP "label"',
      'ALTER TABLE "bots" DROP COLUMN "notes"',
      'DROP TABLE IF EXISTS "old"',
      'ALTER TABLE "bots" RENAME COLUMN "a" TO "b"',
      'ALTER TABLE "bots" RENAME TO "agents"',
    ]);
    expect(unsafeStatements(`${DEFERRED_MIGRATION_MARKER}\n${sql}`)).toEqual([
      'ALTER TABLE "bots" RENAME COLUMN "a" TO "b"',
      'ALTER TABLE "bots" RENAME TO "agents"',
    ]);
  });

  it.each([
    [
      "a column drop inside a DO block",
      "DO $$ BEGIN EXECUTE format('ALTER TABLE %I DROP COLUMN %I', 'bots', 'title'); END $$;",
      "DO $$ BEGIN EXECUTE format('ALTER TABLE %I DROP COLUMN %I', 'bots', 'title')",
    ],
    ["a type drop", 'DROP TYPE "old_status";', 'DROP TYPE "old_status"'],
    ["a view drop", 'DROP VIEW "old_dashboard";', 'DROP VIEW "old_dashboard"'],
  ])("flags %s", (_, sql, statement) => {
    expect(unsafeStatements(sql)).toEqual([statement]);
  });

  it.each([
    ["a function drop", 'DROP FUNCTION IF EXISTS "helper"();'],
    [
      "a policy drop written as dynamic SQL",
      "DO $$ BEGIN EXECUTE format('DROP POLICY %I ON %I', 'a_policy', 'a_table'); END $$;",
    ],
    ["a drop named in a comment", `COMMENT ON TABLE "bots" IS 'DROP TYPE "old_status"';`],
    ["a drop named in a notice", `DO $$ BEGIN RAISE NOTICE 'DROP VIEW "old"'; END $$;`],
  ])("leaves %s alone", (_, sql) => {
    expect(unsafeStatements(sql)).toEqual([]);
  });

  it("reads an indented template as DDL", () => {
    const sql = `EXECUTE format('
        ALTER TABLE %I DROP COLUMN %I', 'bots', 'title');`;
    expect(unsafeStatements(sql)).toEqual([
      "EXECUTE format(' ALTER TABLE %I DROP COLUMN %I', 'bots', 'title')",
    ]);
  });

  it("still lets the marker exempt a drop written as dynamic SQL", () => {
    const sql = `${DEFERRED_MIGRATION_MARKER}
      DO $$ BEGIN EXECUTE format('ALTER TABLE %I DROP COLUMN %I', 'bots', 'title'); END $$;`;
    expect(unsafeStatements(sql)).toEqual([]);
  });
});
