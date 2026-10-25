import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL;
const postgres = enabled ? describe : describe.skip;

// Hot reads that scanned whole tables in production before their index existed.
// Sequential scans are disabled so the planner must reach for an index on a small test table.
const hotQueries = [
  {
    name: "a run's bot replies",
    index: "messages_runId_seq_idx",
    sql: `SELECT id FROM messages WHERE "runId" = $1 AND role = 'bot' ORDER BY seq`,
  },
  {
    name: "a task's runs (delete cascade)",
    index: "runs_taskId_idx",
    sql: `SELECT id FROM runs WHERE "taskId" = $1`,
  },
  {
    name: "a bot's run lease fence",
    index: "runs_botId_idx",
    sql: `SELECT max("leaseFence") FROM runs WHERE "botId" = $1`,
  },
  {
    name: "live execution leases for woken bots",
    index: "computer_execution_leases_botId_expiresAt_idx",
    sql: `SELECT "computerId" FROM computer_execution_leases WHERE "botId" = ANY(ARRAY[$1]) AND "expiresAt" > now()`,
  },
];

postgres("hot query indexes (PostgreSQL)", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it.each(hotQueries)("reads $name through $index", async ({ index, sql }) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, ["missing-id"]);
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(index);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
