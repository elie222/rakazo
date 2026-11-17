# Optional Infisical secret storage

`SECRET_STORE` defaults to `encrypted`. Credentials remain in Postgres using the
existing versioned encryption format (vault items move to the
[content encryption](./content-encryption.md) keys after
`content-encryption migrate`). Keep `ENCRYPTION_KEY` available in both
modes: legacy credentials, one-time codes, and OAuth handshake sessions always
use local encrypted storage. Authentication database tokens are unchanged.

To use Infisical, set the same configuration on API and worker:

```dotenv
SECRET_STORE=infisical
INFISICAL_URL=https://secrets.example.test
INFISICAL_ALLOW_INSECURE_HTTP=false
INFISICAL_CLIENT_ID=replace-with-machine-identity-client-id
INFISICAL_CLIENT_SECRET=replace-with-machine-identity-client-secret
INFISICAL_PROJECT_ID=replace-with-project-id
INFISICAL_ENVIRONMENT=production
INFISICAL_FOLDER=/rakazo
```

`INFISICAL_URL` requires HTTPS except for loopback hosts (`localhost`,
`127.0.0.0/8`, `::1`). Explicitly set `INFISICAL_ALLOW_INSECURE_HTTP=true` for
trusted HTTP deployments, including in-cluster Compose service names. This sends
authentication and secrets without transport encryption.

Create that folder first. Give a universal-auth machine identity read, create,
and delete permissions only in this project, environment, and folder. Use a
dedicated folder and HTTPS outside a trusted local deployment. Infisical can be
self-hosted; no hosted service or SDK is required. Infisical configuration is
validated only when selected.

Each write creates a unique versioned key. Persisted opaque refs occupy the
existing `ciphertext` columns; a failed replacement cannot change the old key.
Refs are bound to their record ids. Readers fetch individual keys, so a new
worker can immediately read a credential saved by the API. No folder is mirrored.

Processes cache at most 256 values for 30 seconds. Local deletion and realtime
fanout invalidate cached refs. Expiry silently discards cached plaintext; a later
read detects a changed value and notifies consumers. Long-lived holders re-validate
credentials on reuse (webhook plaintext has its own 30-second cache). External
rotation means editing the value of the referenced key. Allow up to the cache TTL
plus the next use for rotation to apply. MCP revalidation failures retain existing
live sessions only during typed store outages and retry on their next use. Missing
credentials evict those sessions. MCP and integration settings compare fresh reads
with a digest of their held credentials even after store digest eviction. Already-running
operations may have used credentials loaded before rotation. Shutdown clears
caches and cancels requests. Writes and reads have bounded retries and timeouts.
Concurrent remote reads share one request; caller cancellation cancels only that
caller’s wait.

Secret replacement, row deletion, and parent deletion explicitly clean up unused
remote refs after the database commit. Rollbacks clean up unique new writes.
Agent secret transaction retries write a fresh remote key per attempt. Failed
remote writes attempt deletion with an independent two-second cleanup deadline.
Cleanup is best effort and failures produce redacted warnings. Retry failed
cleanup before revoking machine-identity access; there is no age-based pruning.
Credential rows, bot secrets, vault items and integration provider settings
(the replacement, row deletion, parent deletion and rollback above), computer
settings, messaging workspace credentials, payment wallet credentials,
the sealed copies a purchase did not keep (a paid request, a card or a pay
token) and the key an MCP sign-in refresh wrote when its save failed go further
with a `secret.cleanup` background job. When a row stops
holding a ref, the job is recorded in the transaction that drops it, so a crash
after the commit still deletes the key. For a new write that was never saved,
the job is recorded just before the delete is attempted. The delete is tried at
once; success removes the job and a failure leaves it to the queue's retries.
Both the direct delete and the job first read the record and skip a ref it
holds again. Credential rows, bot secrets, vault items and integration provider
settings can share a ref, so for them that read counts every row of all four
tables, in every Space. Only Infisical refs are recorded: an encrypted ref is the sealed
value itself, leaves with its row, and is never copied into a job. Every other
path is best effort as described above: a failed delete is logged, not retried.
Every Infisical write is recorded first: before the key is created, a
`secret.cleanup` job naming it is queued to run five and a half minutes later
(the write's 30-second deadline plus time for the save that follows). The save
removes the job, in its own transaction for the four secret tables and right
after the commit elsewhere. If the process dies between the write and the save,
the job runs, finds no row in any column that can hold a ref, and deletes the
key; a key a row holds by then is kept. A write whose job cannot be queued is
refused, so no key is created without one. A write inside a database transaction
(a credential refresh) queues its job on that transaction's connection, so it
never waits for a second one; if the transaction rolls back, the job is queued
again afterwards. A process that dies while that transaction is still open loses
the job with it. Writes made before the queue starts, and by tools that run
without one, are not recorded.

## Availability

API and worker start even if Infisical login fails. Encrypted refs continue to
work. Uncached Infisical reads fail with `SECRET_STORE_UNAVAILABLE`; subsequent
operations retry login and reads. Model credential settings return HTTP 503 for
store outages, preserving the distinction from missing credentials. Cached plaintext is discarded at expiry even
through an outage. API liveness remains available; `/ready` returns 503 with
`degraded: true`, and `/internal/health` reports secret-store status. Worker startup
logs degraded storage. A successful later request restores healthy status.

## Migration and rollback

Back up the database and retain the encryption key. Configure Infisical, then run:

```sh
pnpm --filter @rakazo/api secrets:infisical --dry-run
pnpm --filter @rakazo/api secrets:infisical
```

The CLI loads the root `.env` before reading configuration. It covers credential rows, bot secrets, and integration provider settings.
It leaves short-lived run secrets local. It verifies existing refs before
skipping them, compares the original ref during database updates, and deletes
new orphan writes on a failed update. Concurrent edits win. Persisted refs are
the resume markers: rerun after interruption or any reported failure. Output
contains only table labels, row ids, and outcomes; a failed row sets a nonzero
exit code. Dry-run resolves source refs but performs no writes or deletions.

To roll back, keep Infisical accessible and run:

```sh
pnpm --filter @rakazo/api secrets:infisical --reverse --dry-run
pnpm --filter @rakazo/api secrets:infisical --reverse
```

Pause credential writes while completing the final rollback pass, verify it
reports no failures, then set `SECRET_STORE=encrypted` on API and worker and
restart them. Do not disable Infisical while database refs still point to it.
If `SECRET_STORE` is unset or switched to encrypted while Infisical refs remain,
reads fail with a typed storage-unavailable error and one redacted warning per
store instance pointing to the reverse migration. Restore `SECRET_STORE=infisical`
and access to Infisical, then complete the reverse migration before disabling it.
Forward migration can run alongside normal edits; the Infisical selection reads
both formats throughout the transition.
