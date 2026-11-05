import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deployMigrations } from "./deferred-migrations.js";
import type { CaptureAdoptionPhase } from "./turn-memory-capture-adoption.js";
import {
  readCaptureAdoptionSnapshot,
  validateCaptureAdoption,
} from "./turn-memory-capture-adoption.js";

// Opt in only on a disposable server with an owner login allowed to create test databases.
const ownerUrl = process.env.DATABASE_MIGRATION_URL;
const dbTests = process.env.VERIFY_DATABASE && ownerUrl ? describe.sequential : describe.skip;
const dbPackageDir = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = path.join(dbPackageDir, "prisma/migrations");
const operations = path.join(dbPackageDir, "prisma/operations/turn-memory-capture");
const target = "20261201120000_turn_memory_capture";
const originalChecksum = "1e384c600b8a3688e60f7b5096015ca01e8e535ca469a180429645d914ea2bed";
const legacyIndex = 'public."runs_memoryCaptureDueAt_memoryCapturedAt_idx"';

dbTests("first capture adoption on a disposable database", () => {
  const database = `capture_adoption_${randomUUID().replaceAll("-", "")}`;
  let beforeDir: string | undefined;
  let created = false;
  let admin: Client | undefined;
  let client: Client | undefined;
  let migrationUrl: string;
  let predecessors: unknown[];

  function prisma(args: string[], migrationsPath = migrationsDir) {
    return execFileSync("pnpm", ["exec", "prisma", ...args], {
      cwd: dbPackageDir,
      env: {
        ...process.env,
        DATABASE_MIGRATION_URL: migrationUrl,
        RAKAZO_MIGRATIONS_PATH: migrationsPath,
      },
      encoding: "utf8",
      timeout: 45_000,
    });
  }

  async function validate(phase: CaptureAdoptionPhase) {
    return validateCaptureAdoption(await readCaptureAdoptionSnapshot(client!), phase);
  }

  function validatorCli(phase: CaptureAdoptionPhase) {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_MIGRATION_URL: migrationUrl };
    delete env.RAKAZO_MIGRATIONS_PATH;
    return execFileSync(
      process.execPath,
      [
        path.join(dbPackageDir, "../../node_modules/tsx/dist/cli.mjs"),
        path.join(dbPackageDir, "src/cli/validate-capture-adoption.ts"),
        phase,
      ],
      { cwd: dbPackageDir, env, encoding: "utf8", timeout: 10_000 },
    );
  }

  async function holdSnapshot() {
    const reader = new Client({ connectionString: migrationUrl });
    await reader.connect();
    await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await reader.query("SELECT count(*) FROM public.runs");
    return reader;
  }

  beforeAll(async () => {
    const url = new URL(ownerUrl!);
    url.pathname = "/postgres";
    admin = new Client({ connectionString: url.href });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    url.pathname = `/${database}`;
    migrationUrl = url.href;
    client = new Client({ connectionString: migrationUrl });
    await client.connect();
    beforeDir = mkdtempSync(path.join(tmpdir(), "capture-predecessors-"));
    cpSync(migrationsDir, beforeDir, {
      recursive: true,
      filter: (source) => {
        const first = path.relative(migrationsDir, source).split(path.sep)[0]!;
        return first === "" || first === "migration_lock.toml" || first < target;
      },
    });
    prisma(["migrate", "deploy"], beforeDir);
    predecessors = (await readCaptureAdoptionSnapshot(client)).history;
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    if (created) await admin?.query(`DROP DATABASE "${database}"`);
    await admin?.end();
    if (beforeDir) rmSync(beforeDir, { recursive: true, force: true });
  });

  it("validates all real predecessor checksums before the first capture migration", async () => {
    expect(await validate("before")).toEqual({ columns: false, index: false });
    expect(validatorCli("before")).toContain("before: verified; columns=false, index=false");
  });

  it("bounds metadata lock acquisition and leaves no partial columns or target history", async () => {
    const reader = await holdSnapshot();
    const started = Date.now();
    try {
      await expect(
        client!.query(readFileSync(path.join(operations, "columns.sql"), "utf8")),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_800);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await client!.query("ROLLBACK");
      await reader.query("ROLLBACK");
      await reader.end();
    }
    expect(await validate("before")).toEqual({ columns: false, index: false });
  });

  it("preapplies the committed columns with official Prisma db execute", async () => {
    prisma(["db", "execute", "--file", path.join(operations, "columns.sql")]);
    expect(await validate("before")).toEqual({ columns: true, index: false });
    await expect(validate("prepared")).rejects.toThrow(/index/);
  });

  it("refuses a real canceled concurrent index and does not baseline it away", async () => {
    const reader = await holdSnapshot();
    const builder = new Client({ connectionString: migrationUrl });
    await builder.connect();
    try {
      await builder.query("SET statement_timeout = '300ms'");
      await expect(
        builder.query(readFileSync(path.join(operations, "index.sql"), "utf8")),
      ).rejects.toMatchObject({ code: "57014" });
      const state = await readCaptureAdoptionSnapshot(client!);
      expect(state.indexes).toHaveLength(1);
      expect(state.indexes[0]!.valid).toBe(false);
      expect(() => validateCaptureAdoption(state, "prepared")).toThrow(/index/);
      expect(state.history.some((row) => row.migration_name === target)).toBe(false);
    } finally {
      await builder.end();
      await reader.query("ROLLBACK");
      await reader.end();
      await client!.query(`DROP INDEX CONCURRENTLY IF EXISTS ${legacyIndex}`);
    }
  });

  it("allows row writes while the official concurrent build waits for an old snapshot", async () => {
    const reader = await holdSnapshot();
    const build = new Promise<Error | undefined>((resolve) => {
      execFile(
        "pnpm",
        ["exec", "prisma", "db", "execute", "--file", path.join(operations, "index.sql")],
        {
          cwd: dbPackageDir,
          env: {
            ...process.env,
            DATABASE_MIGRATION_URL: migrationUrl,
            RAKAZO_MIGRATIONS_PATH: migrationsDir,
          },
          timeout: 20_000,
        },
        (error) => resolve(error ?? undefined),
      );
    });
    const writer = new Client({ connectionString: migrationUrl });
    await writer.connect();
    try {
      let pid: number | undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const { rows } = await client!.query<{ pid: number }>(`
          SELECT pid FROM pg_stat_progress_create_index
          WHERE relid = 'public.runs'::regclass AND phase = 'waiting for old snapshots'
        `);
        pid = rows[0]?.pid;
        if (pid !== undefined) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(pid, "concurrent build should wait for the deliberately held snapshot").toBeDefined();
      const { rows: locks } = await client!.query<{ mode: string }>(
        "SELECT mode FROM pg_locks WHERE pid = $1 AND relation = 'public.runs'::regclass AND granted",
        [pid],
      );
      expect(locks.map((lock) => lock.mode)).toContain("ShareUpdateExclusiveLock");
      expect(locks.map((lock) => lock.mode)).not.toContain("ShareLock");
      await writer.query("SET lock_timeout = '250ms'; SET statement_timeout = '1s'");
      const write = await writer.query('UPDATE public.runs SET "id" = "id" WHERE false');
      expect(write.rowCount).toBe(0);
    } finally {
      await writer.end();
      await reader.query("ROLLBACK");
      await reader.end();
      expect(await build).toBeUndefined();
    }
    expect(await validate("prepared")).toEqual({ columns: true, index: true });
    expect(validatorCli("prepared")).toContain("prepared: verified; columns=true, index=true");
  });

  it("uses official resolve and reads back the unchanged target and predecessor checksums", async () => {
    prisma(["migrate", "resolve", "--applied", target]);
    expect(await validate("resolved")).toEqual({ columns: true, index: true });
    expect(validatorCli("resolved")).toContain("resolved: verified; columns=true, index=true");
    const state = await readCaptureAdoptionSnapshot(client!);
    expect(state.history.find((row) => row.migration_name === target)?.checksum).toBe(
      originalChecksum,
    );
    expect(state.history.filter((row) => row.migration_name < target)).toEqual(predecessors);
    await expect(validate("before")).rejects.toThrow(/already recorded/);
  });

  it("finishes normal deploy without rerunning the legacy build and adds the partial index", async () => {
    await deployMigrations({ migrationUrl, dbPackageDir, lockRetryDelaysMs: [] });
    const { rows } = await client!.query(`
      SELECT i.indisvalid AS valid, pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i WHERE i.indexrelid = 'public.runs_pending_memory_capture_idx'::regclass
    `);
    expect(rows).toEqual([
      {
        valid: true,
        predicate: '(("memoryCaptureDueAt" IS NOT NULL) AND ("memoryCapturedAt" IS NULL))',
      },
    ]);
    const state = await readCaptureAdoptionSnapshot(client!);
    expect(state.history.find((row) => row.migration_name === target)?.checksum).toBe(
      originalChecksum,
    );
    expect(state.history.filter((row) => row.migration_name < target)).toEqual(predecessors);
  });

  it("uses the new migration to avoid scanning confirmed history in a synthetic due/id query", async () => {
    await client!.query(`
      CREATE TABLE public.capture_index_probe (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, "memoryCaptureDueAt" TIMESTAMP(3), "memoryCapturedAt" TIMESTAMP(3)
      );
      INSERT INTO public.capture_index_probe
      SELECT 'history-' || n, 'completed', '2026-01-01'::timestamp + n * interval '1 millisecond', '2026-01-02'::timestamp
      FROM generate_series(1, 300000) n;
      INSERT INTO public.capture_index_probe
      SELECT 'pending-' || n, 'completed', '2026-01-03'::timestamp + n * interval '1 millisecond', NULL
      FROM generate_series(1, 10) n;
      INSERT INTO public.capture_index_probe VALUES ('no-due', 'completed', NULL, NULL);
      CREATE INDEX capture_probe_legacy ON public.capture_index_probe ("memoryCaptureDueAt", "memoryCapturedAt");
      ANALYZE public.capture_index_probe;
    `);
    const query = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id FROM public.capture_index_probe
      WHERE status = 'completed' AND "memoryCaptureDueAt" IS NOT NULL AND "memoryCapturedAt" IS NULL
      ORDER BY "memoryCaptureDueAt", id LIMIT 100`;
    const oldPlan = (await client!.query(query)).rows[0]["QUERY PLAN"][0].Plan;
    const sql = readFileSync(
      path.join(migrationsDir, "20261206120000_pending_capture_index/migration.sql"),
      "utf8",
    )
      .replace('"runs_pending_memory_capture_idx"', '"capture_probe_pending"')
      .replace('ON "runs"', 'ON public."capture_index_probe"');
    await client!.query(sql);
    await client!.query("ANALYZE public.capture_index_probe");
    const plan = (await client!.query(query)).rows[0]["QUERY PLAN"][0].Plan;
    expect(JSON.stringify(plan)).toContain('"Index Name":"capture_probe_pending"');
    expect(plan["Actual Rows"]).toBe(10);
    const oldBlocks = oldPlan["Shared Hit Blocks"] + oldPlan["Shared Read Blocks"];
    const newBlocks = plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
    expect(newBlocks).toBeLessThan(oldBlocks / 10);
    const { rows: counts } = await client!.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.capture_index_probe",
    );
    expect(counts[0]!.count).toBe(300011);
    process.stdout.write(
      `${JSON.stringify({ syntheticRows: counts[0]!.count, returned: plan["Actual Rows"], oldBlocks, newBlocks })}\n`,
    );
  });
});
