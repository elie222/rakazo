import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresReconciliationLeadership } from "./job-reconciler.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("job reconciliation leadership (PostgreSQL contract)", () => {
  it("elects one session and hands leadership to a follower after release", async () => {
    const pool = new Pool({ connectionString: databaseUrl!, max: 2 });
    const lockId = -Math.min(process.pid, 2_000_000_000);
    const first = createPostgresReconciliationLeadership(pool, { lockId });
    const second = createPostgresReconciliationLeadership(pool, { lockId });

    try {
      await expect(first.tryAcquire()).resolves.toBe(true);
      await expect(second.tryAcquire()).resolves.toBe(false);

      await first.release();
      await expect(second.tryAcquire()).resolves.toBe(true);
    } finally {
      await first.release();
      await second.release();
      await pool.end();
    }
  });
});
