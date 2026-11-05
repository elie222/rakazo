# First adoption of turn-memory capture

Migration `20261201120000_turn_memory_capture` contains a normal `CREATE INDEX` on
`runs`. On an existing large table its build blocks writes. The later concurrent
pending-only index improves capture scans; **it does not make that first build
concurrent**. Applied migration files must not be edited, even on deployments
that have already adopted capture.

For an existing deployment that has not recorded the first capture migration,
use the operator procedure below **before any normal migration/deploy command**.
It preapplies the exact legacy schema with a concurrent build, then uses official
Prisma `migrate resolve --applied` against the unchanged migration file. It is
not an automatic upgrade hook or a general failed-migration repair tool.
Already-applied deployments skip this procedure. Empty installs have no existing
traffic to protect and can migrate normally.

## Preconditions

- Rehearse on a disposable restored backup first; take a current backup.
- Pause every deployment/migration actor (including CI, updater and startup
  migration jobs) for the whole procedure. No other operator may run DDL or
  `migrate resolve`. The read-only checks are not a cross-command deployment lock.
  The previous API and worker may stay running during preapply.
- Use a checkout of the release with its installed dependencies and the migration
  owner login. From the repository root, explicitly export
  `DATABASE_MIGRATION_URL` through your normal secret handling. The validator
  does not load `.env` or fall back to `DATABASE_URL`. Use only `public`, no URL
  `options`/search-path overrides, and unset `RAKAZO_MIGRATIONS_PATH`.
- Every predecessor must already be successfully applied with its original
  checksum, including deferred migrations. If not, finish upgrading the prior
  release through its supported procedure first; do not force held-back drops
  while an old release still reads them. The validator refuses unknown, missing,
  duplicate, failed, out-of-order or checksum-drifted history, partitioned tables,
  partial/drifted capture columns and invalid/mismatched legacy indexes.
- Review long transactions, DDL contention, disk space and build resource costs.
  The column change still requires an `ACCESS EXCLUSIVE` lock: acquisition is
  bounded to 2 seconds and the statement to 10 seconds. This is not a zero-lock
  or zero-downtime guarantee. A concurrent build permits row writes but may wait
  for transactions and consumes I/O/disk. Review server/role timeout settings too.

## Preapply and resolve

Run commands individually and stop on any nonzero exit. Do not combine the two
SQL files or wrap the index build in a transaction.

```bash
# Must report columns=false, index=false on an untouched first adoption.
pnpm exec tsx packages/db/src/cli/validate-capture-adoption.ts before

# Atomic, bounded metadata change; commits before the build starts.
pnpm --filter @rakazo/db exec prisma db execute \
  --file prisma/operations/turn-memory-capture/columns.sql

# Sole statement: exact legacy index, but built concurrently.
pnpm --filter @rakazo/db exec prisma db execute \
  --file prisma/operations/turn-memory-capture/index.sql

# Checks exact nullable/no-default column types, index definition/validity,
# and predecessor checksums again. Do not resolve if this fails.
pnpm exec tsx packages/db/src/cli/validate-capture-adoption.ts prepared

pnpm --filter @rakazo/db exec prisma migrate resolve \
  --applied 20261201120000_turn_memory_capture

# Read back the successful history row and its original SHA-256 checksum.
pnpm exec tsx packages/db/src/cli/validate-capture-adoption.ts resolved
```

The recorded checksum must be
`1e384c600b8a3688e60f7b5096015ca01e8e535ca469a180429645d914ea2bed`.
There are no direct writes to `_prisma_migrations` in this procedure.

Only after `resolved` succeeds may the normal release migration/deploy continue.
Plan a maintenance window for the remaining pending migrations: the shared
`deployMigrations` runner currently omits its lock timeout for **all** pending
migrations whenever any pending migration contains `CONCURRENTLY`. Later capture
column migrations can therefore still wait for a write-blocking metadata lock.
This procedure does not change that runner or promise an online upgrade for
other migrations. Keep automation paused until the normal rollout is complete;
then resume it. The original broad index remains, matching the Prisma schema;
`20261206120000_pending_capture_index` adds the small `(due, id)` scan index where
`due IS NOT NULL AND captured IS NULL` without deleting or rewriting history.

## Interrupted attempts

- A lock/statement timeout in `columns.sql` rolls back all three additions. Run
  `before` again and retry later; do not bypass the timeouts.
- If the exact columns already exist, `before` reports `columns=true`; skip
  `columns.sql`. If the exact valid index also exists, skip `index.sql` as well.
- A canceled/failed concurrent build may leave an invalid same-named index.
  `before` and `prepared` deliberately reject it; `IF NOT EXISTS` is not used.
  With migration actors still paused, inspect the exact `public` index and
  `pg_stat_progress_create_index`, ensure no build is active, and only if it is
  the artifact from this attempt remove it with a standalone
  `DROP INDEX CONCURRENTLY public."runs_memoryCaptureDueAt_memoryCapturedAt_idx";`.
  Then rerun `before`, skip the existing columns, rebuild and validate. Do not
  drop a valid/mismatched operator-owned index blindly.
- If official `resolve` succeeded but the shell disconnected, run `resolved`,
  not `resolve` a second time. A failed/previously recorded target migration,
  altered schema, non-public schema or unknown history needs a separate reviewed
  recovery plan; this first-adoption procedure must not baseline it away.

Offline contract/guard tests run with `pnpm exec vitest run
packages/db/src/pending-capture-index.test.ts
packages/db/src/turn-memory-capture-adoption*.test.ts`. The PostgreSQL suite is
opt-in with `VERIFY_DATABASE=1` and an owner `DATABASE_MIGRATION_URL`; use only a
new disposable database server. It creates/drops its own test database, applies
real predecessors, exercises official Prisma preapply/resolve/deploy, observes
locks during a concurrent build, and checks a synthetic pending-scan plan.
