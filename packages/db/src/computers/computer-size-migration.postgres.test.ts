import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("per-computer size migration (PostgreSQL)", () => {
  it("gives each computer its organization's size and new computers Standard", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Temporary tables shadow the real ones; this test never alters real rows.
      await client.query(
        `CREATE TEMP TABLE organization (id TEXT PRIMARY KEY, "computerSize" TEXT NOT NULL DEFAULT 'standard') ON COMMIT DROP`,
      );
      await client.query(
        `CREATE TEMP TABLE spaces (id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL) ON COMMIT DROP`,
      );
      await client.query(
        `CREATE TEMP TABLE computers (id TEXT PRIMARY KEY, "spaceId" TEXT NOT NULL) ON COMMIT DROP`,
      );
      await client.query(
        `INSERT INTO organization (id, "computerSize") VALUES ('big', 'xlarge'), ('plain', 'standard')`,
      );
      await client.query(
        `INSERT INTO spaces (id, "organizationId") VALUES ('big-1', 'big'), ('big-2', 'big'), ('plain-1', 'plain')`,
      );
      await client.query(
        `INSERT INTO computers (id, "spaceId") VALUES ('a', 'big-1'), ('b', 'big-2'), ('c', 'plain-1')`,
      );
      await client.query(
        await readFile(
          new URL(
            "../../prisma/migrations/20261231140000_computer_size_per_computer/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect((await client.query("SELECT id, size FROM computers ORDER BY id")).rows).toEqual([
        { id: "a", size: "xlarge" },
        { id: "b", size: "xlarge" },
        { id: "c", size: "standard" },
      ]);
      await client.query(`INSERT INTO computers (id, "spaceId") VALUES ('new', 'big-1')`);
      expect((await client.query("SELECT size FROM computers WHERE id = 'new'")).rows).toEqual([
        { size: "standard" },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});
