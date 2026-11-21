# Encrypted message search backfill verification

## Search before and after backfill

On PostgreSQL 18.7, space search found the synthetic message `我们今天讨论部署方案` by `我们今天` while it still had its old prefix index. Searching for `部署` returned zero messages. After backfill, both queries returned the same original message ID.

The regression creates three encrypted messages, saves their stored ciphertext and current tokens, and replaces their tokens with ones from the original prefix algorithm. It then rotates the space key and adds one newly indexed message and one plaintext message. Rebuilt history tokens include an attachment name, a step label and a step note. A synthetic value held only in encrypted tool history has no whole-word or prefix token in the rebuilt index. [PostgreSQL regression](../../apps/api/src/content/search-backfill.postgres.test.ts)

A block with a historical kind retained its search hit for `Windmill` before and after the rebuild. An entry missing its kind produced no search hit for `Woodpecker` in either index, and the rebuilt index dropped its prefix token. Both entries remained in the original ciphertext.

| Step                                                                     | Observed outcome                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Process one message and pause                                            | One message scanned and updated. The target was second and still missing from the results for `部署`.                                                                                            |
| Append a message during the pause                                        | The new message was immediately searchable by `追加`. It fell beyond the backfill's original stopping point.                                                                                     |
| Resume on a second database client with a damaged block after the target | Each of five failures identified the damaged message by ID. The target kept its old search behavior after each rollback.                                                                         |
| Repair the damaged block and resume                                      | Both messages in the failed batch were scanned and updated. A stop signal after the commit paused the run. The target's ciphertext and tokens matched the snapshot taken under its original key. |
| Finish the pass                                                          | The remaining newly indexed message and plaintext message were scanned, with zero updates. Both retained their original stored values. Running again scanned and updated zero messages.          |

The five failures covered an invalid envelope, a missing key, an envelope encrypted with another space's key, ciphertext bound to another message's ID, and authenticated plaintext that could not be parsed as JSON. In each case the error contained only the diagnostic and the affected message ID.

A separate regression injected a key-provider response error during unwrapping and a database connection error during thread lookup. Each reached the caller as the original error object. The message retained its old index after both failures. Retrying scanned and updated it once, and the search for `部署` found it.

The vault suite exercised the same local key provider with a missing master key and an unreadable wrapped key. In both cases the redaction loader stopped and a replacement save left the existing login ciphertext intact, even with a newer key available for writes. Restoring the old key made the original password available for redaction again. [Vault regression](../../packages/adapters/src/secrets/vault/vault-values.test.ts)

The CLI maps Ctrl+C and SIGTERM to the abort signal exercised at the commit boundary. The checkpoint table has a system-only row-level security policy. The PostgreSQL catalog test confirmed that the tables with row-level security enabled match the client's protected-model list, including the checkpoint. [CLI signal handling](../../apps/api/src/cli/content-encryption.ts) · [Checkpoint policy](../../packages/db/prisma/migrations/20261231150100_message_search_backfill/migration.sql) · [Catalog test](../../packages/db/src/database/row-security.postgres.test.ts)

## Separate CLI process check

A separate PostgreSQL 18.7 smoke test used three legacy-indexed encrypted messages containing `部署`, including `我们今天讨论部署方案`. Each invocation started a new CLI process with encryption disabled for new writes.

| Invocation                             | Scanned | Updated | Messages found by `部署` |
| -------------------------------------- | ------: | ------: | -----------------------: |
| Before backfill                        |       — |       — |                        0 |
| First run, limited to one batch of one |       1 |       1 |                        1 |
| Second run, resumed to completion      |       2 |       2 |                        3 |
| Third run, already complete            |       0 |       0 |                        3 |

The CLI also rejected a batch size of zero and a batch-limit flag on an unrelated command before connecting to the database. [Operator commands](../content-encryption.md#backfill-encrypted-message-search)

## Validation on the PR base

On PostgreSQL 18.7, all 97 integration tests passed across seven suites. The suites covered space search (6), search backfill (2), CLI interruption and resume (1), content encryption (19), history retrieval (28), row-level security (23) and encrypted vault values (18). Each suite used its own fully migrated database and the ordinary runtime role with the system key configured. All 252 tests in the eight unit suites passed, including vault safeguards for an unavailable master key. The API, database and adapters packages passed their TypeScript checks. Biome checked the repository with zero errors. The separate CLI check above used the same migration and permissions.

## Reproduce the integration checks

Run these commands from the repository root with dependencies installed and Docker available. The integration harness starts PostgreSQL, runs migrations and gives each selected suite its own database. The search suite also checks legacy and current indexes together across a key rotation.

```sh
pnpm test:integration --spec=search-backfill.postgres.test.ts
pnpm test:integration --spec=search.postgres.test.ts
pnpm test:integration --spec=row-security.postgres.test.ts
pnpm test:integration --spec=content-encryption.postgres.test.ts
pnpm test:integration --spec=history-retrieval.postgres.test.ts
pnpm test:integration --spec=backfill-interrupt.postgres.test.ts
pnpm test:integration --spec=vault-values.postgres.test.ts
```

The unit suites and type checks run from the same directory.

```sh
pnpm exec vitest run packages/db/src/encryption/content-keys.test.ts packages/db/src/encryption/content-crypto.test.ts packages/db/src/encryption/content-encryption.test.ts apps/api/src/content/search.test.ts packages/core/src/primitives/search.test.ts packages/db/src/history/history-retrieval.test.ts packages/db/src/database/row-security.test.ts packages/adapters/src/secrets/vault/vault-values.test.ts
pnpm --filter @rakazo/api check
pnpm --filter @rakazo/db check
pnpm --filter @rakazo/adapters check
pnpm exec biome check .
```

## CLI interruptions and exit codes

Four CLI processes shared one PostgreSQL 18.7 database containing four encrypted messages with missing indexes. Each process used a batch size of one. For the first two runs, the test dispatched the Node signal event as soon as the CLI reported its first committed batch. The parent process read the child's actual exit status and verified the durable checkpoint between runs.

| CLI invocation                                | Exit code | Committed progress                                                 |
| --------------------------------------------- | --------: | ------------------------------------------------------------------ |
| Dispatch `SIGINT` after the first batch       |       130 | Paused after message 1                                             |
| Resume and dispatch `SIGTERM` after one batch |       143 | Paused after message 2                                             |
| Resume with `--max-batches 1`                 |         0 | Paused after message 3                                             |
| Resume to completion                          |         0 | Scanned and updated only message 4. All four messages had indexes. |

A separate native Windows check sent an operating-system Ctrl+C event to the CLI in its own console after its first progress line. The next batch was already in flight. The CLI exited with 130 and saved the checkpoint at message 2 of 12. A fresh process scanned and updated the remaining 10 messages and exited with 0. The SIGTERM result above covers Node's signal handler and process exit status. Windows does not deliver POSIX SIGTERM to a Node process.

To repeat the native check in PowerShell, point the CLI at a disposable database containing enough legacy messages to interrupt. Press Ctrl+C after a progress line and check the exit code. The number of committed batches depends on when the signal arrives.

```powershell
node --import tsx apps/api/src/cli/content-encryption.ts backfill-search --batch-size 1
$LASTEXITCODE
node --import tsx apps/api/src/cli/content-encryption.ts backfill-search
$LASTEXITCODE
```

Run the four-process regression from the repository root. [Regression test](../../apps/api/src/cli/backfill-interrupt.postgres.test.ts)

```sh
pnpm test:integration --spec=backfill-interrupt.postgres.test.ts
```
