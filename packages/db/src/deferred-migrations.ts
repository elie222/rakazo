import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";

/** First line of a migration that may only run once the release before it has stopped. */
export const DEFERRED_MIGRATION_MARKER = "-- deferred";

/**
 * Names of `-- deferred` migrations to leave out of this run. Each is held back the first time a
 * migration run sees it and applied on the next, so it lands one release after the code that stops
 * reading what it drops. That keeps the previous release working while the two run side by side,
 * and keeps rolling back one release safe. A database with no applied migrations holds nothing.
 */
export async function heldBackMigrations(
  migrationUrl: string,
  migrationsDir: string,
): Promise<string[]> {
  const deferred = readdirSync(migrationsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        readFileSync(path.join(migrationsDir, entry.name, "migration.sql"), "utf8").startsWith(
          DEFERRED_MIGRATION_MARKER,
        ),
    )
    .map((entry) => entry.name);
  if (deferred.length === 0) return [];
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    const { rows: tables } = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('_prisma_migrations') IS NOT NULL AS exists",
    );
    if (!tables[0]?.exists) return [];
    const { rows: applied } = await client.query<{ migration_name: string }>(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    );
    if (applied.length === 0) return [];
    const done = new Set(applied.map((row) => row.migration_name));
    const pending = deferred.filter((name) => !done.has(name));
    if (pending.length === 0) return [];
    await client.query(
      'CREATE TABLE IF NOT EXISTS "_deferred_migrations" (name TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const { rows: firstSeen } = await client.query<{ name: string }>(
      'INSERT INTO "_deferred_migrations" (name) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING RETURNING name',
      [pending],
    );
    return firstSeen.map((row) => row.name);
  } finally {
    await client.end();
  }
}

/** `prisma migrate deploy` from the database package, without the migrations held back this run. */
export async function deployMigrations(input: {
  migrationUrl: string;
  dbPackageDir: string;
  migrationsDir?: string;
}) {
  const migrationsDir = input.migrationsDir ?? path.join(input.dbPackageDir, "prisma/migrations");
  const held = await heldBackMigrations(input.migrationUrl, migrationsDir);
  let migrationsPath = migrationsDir;
  if (held.length) {
    migrationsPath = mkdtempSync(path.join(tmpdir(), "rakazo-migrations-"));
    cpSync(migrationsDir, migrationsPath, {
      recursive: true,
      filter: (source) => !held.includes(path.relative(migrationsDir, source).split(path.sep)[0]!),
    });
    process.stdout.write(`Holding back until the next migration run: ${held.join(", ")}\n`);
  }
  try {
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: input.dbPackageDir,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_MIGRATION_URL: input.migrationUrl,
        RAKAZO_MIGRATIONS_PATH: migrationsPath,
      },
    });
  } finally {
    if (migrationsPath !== migrationsDir) rmSync(migrationsPath, { recursive: true, force: true });
  }
}
