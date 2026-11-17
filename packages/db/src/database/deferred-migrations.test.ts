import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deployMigrations } from "./deferred-migrations.js";

type Query = (sql: string) => Promise<{ rows: unknown[] }>;
const database = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  query: vi.fn<Query>(),
}));

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("pg", () => ({
  Client: class {
    connect = database.connect;
    query = database.query;
    end = async () => undefined;
  },
}));

const dbPackageDir = fileURLToPath(new URL("../..", import.meta.url));
const migrationsDir = mkdtempSync(path.join(tmpdir(), "deferred-migrations-unit-"));
mkdirSync(path.join(migrationsDir, "20000101000000_add"));
writeFileSync(
  path.join(migrationsDir, "20000101000000_add", "migration.sql"),
  "ALTER TABLE probe ADD COLUMN extra INT;\n",
);
const migrateFailed = new Error("Command failed: prisma migrate deploy");
const failedMigration = (logs: string) => [
  { id: "migration-1", migration_name: "20000101000000_add", logs },
];
const deploy = () =>
  deployMigrations({
    migrationUrl: "postgres://owner@db.invalid/app",
    dbPackageDir,
    migrationsDir,
    lockRetryDelaysMs: [0],
  });
/** Answers the queries a deploy makes, with `unfinished` as the migrations left half applied. */
const answering =
  (unfinished: unknown[]): Query =>
  async (sql) => ({
    rows: sql.includes("to_regclass")
      ? [{ exists: false }]
      : sql.includes("finished_at IS NULL")
        ? unfinished
        : [],
  });

describe("deployMigrations", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    database.connect.mockReset().mockResolvedValue(undefined);
    database.query.mockReset();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.mocked(process.stdout.write).mockRestore());
  afterAll(() => rmSync(migrationsDir, { recursive: true, force: true }));

  it("retries a migration that lost a lock", async () => {
    database.query.mockImplementation(answering(failedMigration("ERROR: 55P03 lock timeout")));
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw migrateFailed;
    });
    await expect(deploy()).resolves.toBeUndefined();
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it("reports the migration's own failure when it did not lose a lock", async () => {
    database.query.mockImplementation(answering(failedMigration("ERROR: 42703 no such column")));
    vi.mocked(execFileSync).mockImplementation(() => {
      throw migrateFailed;
    });
    await expect(deploy()).rejects.toBe(migrateFailed);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("reports a failed lock check together with the migration's failure", async () => {
    const checkFailed = new Error("connection refused");
    database.query.mockImplementation(answering([]));
    vi.mocked(execFileSync).mockImplementation(() => {
      // The check after the failed run is the next connection.
      database.connect.mockRejectedValueOnce(checkFailed);
      throw migrateFailed;
    });
    const failure = await deploy().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([migrateFailed, checkFailed]);
  });
});
