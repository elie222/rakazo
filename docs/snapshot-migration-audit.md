# Snapshot-to-Git Migration Audit

Date: 2026-08-30

## Source preservation

- Source snapshot retained at `/Users/ufuksamet/Desktop/rakazo-main`.
- Read-only backup created at `/Users/ufuksamet/Desktop/rakazo-main-snapshot-backup-20260830`.
- Clean Git clone: `/Users/ufuksamet/Desktop/rakazo-git`.
- Upstream: `https://github.com/elie222/rakazo.git`.
- Base: `d9f37db fix(web): center composer and persist bot order (#392)` on `main`.
- Transfer branch: `feat/autonomous-organization-runtime`.
- Recovered commit: `06f76e7 feat: add autonomous organization runtime`.

## Inventory

The snapshot introduced a new `@rakazo/organization` package, organization contracts and API surface, database migrations, execution/manager/progress adapters, deterministic queue support, PostgreSQL migration smoke coverage, and the PostgreSQL flagship autonomy test.

Modified upstream files were merged selectively rather than copied wholesale. In particular, the current upstream executor's bot-message behavior was retained while Organization run-finalization and approval hooks were added. Generated Prisma output, dependencies, build products, caches, local database directories, and environment files were not transferred.

## Organization migration chain preserved

1. `20260829024754_add_organization_layer`
2. `20260830090000_add_work_item_executions`
3. `20260830100000_add_work_item_review_run`
4. `20260830110000_add_manager_evaluations`
5. `20260830120000_add_work_item_required`
6. `20260830130000_manager_evaluation_attempt_keys`

No migration was renamed, regenerated, squashed, or reordered.

## Validation at transfer time

- Prisma schema validation passed.
- Prisma client generation passed.
- Contracts, organization, adapter-kit, adapters, API, worker, and testkit typechecks passed.
- Selected organization and bridge tests passed (28 assertions).
- PostgreSQL smoke and flagship test files parse but are skipped locally because their database gate is disabled. They require the repository-supported Linux/Testcontainers CI path.

## Known limitations

- The snapshot's macOS 27 + Node 26 Prisma schema-engine failure remains environment-specific; it is not evidence of a PostgreSQL or migration failure.
- Docker/Testcontainers is unavailable locally, so no PostgreSQL migration or flagship behavioral result is claimed here.
- GitHub CI is pending writable GitHub authentication. The configured upstream remote is read-only for this environment; neither GitHub CLI nor SSH credentials are available, and HTTPS has no non-interactive credential.
