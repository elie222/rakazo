import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../database/client.js";

// Needs the owner URL, as `pnpm test:integration` provides after `pnpm db:migrate`.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("page reader state policies", () => {
  let owner: ReturnType<typeof createDb>;

  beforeAll(() => {
    owner = createDb(migrationUrl as string);
  });

  afterAll(async () => {
    await owner.prisma.$disconnect();
    await owner.pool.end();
  });

  it("scopes a saved page value to the reader's Space", async () => {
    const policies = await owner.prisma.$queryRaw<Array<{ policyname: string; qual: string }>>`
      SELECT policyname, qual::text AS qual
      FROM pg_policies
      WHERE tablename = 'page_reader_states'`;
    const tenant = policies.find((policy) => policy.policyname === "page_reader_states_tenant");
    expect(tenant, "page_reader_states has no tenant policy").toBeDefined();
    // The predicate itself, not just the column name, so a policy that stopped comparing the
    // configured Space fails here instead of passing on a mention of the column.
    expect(tenant?.qual).toMatch(/"spaceId"\s*=\s*NULLIF\(current_setting\('app\.space_id'/);
  });
});
