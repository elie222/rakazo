import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deployMigrations } from "./deferred-migrations.js";

const ownerUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const dbTests = process.env.VERIFY_DATABASE && ownerUrl ? describe : describe.skip;
const dbPackageDir = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATION = "20261225130000_database_time_zone_utc";

dbTests("database time zone", () => {
  const database = `time_zone_${process.pid}_${Date.now()}`;
  let dir: string;
  let admin: Client;

  function urlFor(name: string) {
    const url = new URL(ownerUrl!);
    url.pathname = `/${name}`;
    return url.href;
  }

  async function sessionTimeZone() {
    const client = new Client({ connectionString: urlFor(database) });
    await client.connect();
    try {
      const { rows } = await client.query<{ TimeZone: string }>("SHOW timezone");
      return rows[0]!.TimeZone;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    // Set up here, not while collecting: a skipped suite has no database URL to read.
    dir = mkdtempSync(path.join(tmpdir(), "time-zone-migrations-"));
    admin = new Client({ connectionString: urlFor("postgres") });
    cpSync(path.join(dbPackageDir, "prisma/migrations", MIGRATION), path.join(dir, MIGRATION), {
      recursive: true,
    });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    // Stands in for a server whose default time zone is not UTC.
    await admin.query(`ALTER DATABASE "${database}" SET timezone TO 'America/New_York'`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs every new session in UTC once migrated", async () => {
    expect(await sessionTimeZone()).toBe("America/New_York");
    await deployMigrations({ migrationUrl: urlFor(database), dbPackageDir, migrationsDir: dir });
    expect(await sessionTimeZone()).toBe("UTC");
  });
});
