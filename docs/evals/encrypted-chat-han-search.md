# Encrypted chat search verification

## Results on PostgreSQL 18.7

The integration tests exercised the normal search API against a fully migrated database with an ordinary runtime role and row-level security enabled. All rows and keys were synthetic. The four PostgreSQL suites passed 77 tests, including seven space search tests. The six related unit suites passed 169 tests. The API and database TypeScript checks and repository lint passed.

| Case                              | Observed result                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New Chinese and mixed-script chat | `部署` found both messages with and without a space before `API`. `部署API`, `署A` and `I服` found the contiguous form. `部署 API` found the spaced form.                |
| Original prefix-only ciphertext   | `我们今天` found the original row before and after rotating its space key. The interior query `部署` returned only new messages.                                         |
| 501 newer prefix candidates       | Search found `我们今天讨论部署方案细节` behind 501 messages sharing its first ten characters. The target qualifies for both predicates but is outside the prefix window. |
| 501 newer pair candidates         | Search found the original prefix-only row `归档期限已经确认` despite 501 newer rows with the query's pairs in different phrases.                                         |
| Long Han-and-digit run            | The 84,000-character counterexample plus `部署API` used 27 tokens. The literal tail query `999部署API` found the row.                                                    |
| Group eligibility                 | The encrypted group message matched while the group had two active members. The same query omitted it after one member was archived.                                     |

The long fixture with the tail had 13 original tokens and 27 with Han pairs. In the message table, `pg_column_size("searchTokens")` measured 73 B for the original array and 132 B for the new array on that row.

I reran both crowding fixtures with a shared 500-ID limit. Both then missed the target. Restoring the former query's exclusion of all prefix matches before limiting to 500 pair candidates also reproduced the first miss.

[PostgreSQL search regressions](../../apps/api/src/content/search.postgres.test.ts)

## Index size and coverage

The 512-pair limit applies to all additional tokens. Each token occupies four bytes in the integer payload, for a maximum addition of 2,048 bytes per message. The original words and prefixes are still indexed. A unit fixture with more than 512 distinct qualifying pairs reaches the cap and still retains ordinary tokens after it. An interior query that needs a pair first seen past the cap may miss a message. Each predicate selects at most 500 candidates per direct or group lookup before the two sets of selected rows are combined. Frequent pairs can fill their own candidate window.

The exact 84,000-character string uses `中` followed by each number from 100000 through 111999, concatenated without spaces. With a fixed synthetic key this yields 24 tokens, up from 13 with prefixes and history words alone. Its 11 extra tokens are the distinct Han/digit boundaries. This measurement counts integer payload rather than the PostgreSQL array header or GIN storage. [Token regressions](../../packages/db/src/encryption/content-crypto.test.ts)

I also replayed the [earlier PR's 23 synthetic messages and 28 queries](https://github.com/elie222/rakazo/blob/ac0d97f04ab5e30e4fdd803381483f8c8592c5d2/packages/db/scripts/zh-search-fixtures.ts). The replay formed prefix and pair candidates in memory with the production token functions, then checked literal text. The original short-query scan covers all 23 rows in this fixture. For storage, the same token arrays were loaded into separate temporary PostgreSQL 18.7 tables, then indexed with GIN. Array sizes are `sum(pg_column_size(tokens))`. Index sizes are the GIN main fork as measured by `pg_relation_size`.

| Encoding                      | Expected query–message matches returned | Total tokens | Array storage | GIN main fork |
| ----------------------------- | --------------------------------------: | -----------: | ------------: | ------------: |
| Original words and prefixes   |                                   27/52 |          353 |       1,895 B |        16 KiB |
| Original index plus Han pairs |                                   46/52 |          560 |       2,747 B |        40 KiB |

All six missed matches use ASCII-only queries, such as `api` within `今晚部署API服务` or `sql16` within `PostgreSQL16`. These storage figures describe the included synthetic sample. Query latency and index growth on a production-sized message database were not measured.

## Reproduce the regressions

Run the repository's integration harness with dependencies installed and Docker available. The harness starts PostgreSQL, applies migrations and sets up the runtime role.

```sh
pnpm test:integration --spec=search.postgres.test.ts
pnpm test:integration --spec=content-encryption.postgres.test.ts
pnpm test:integration --spec=history-retrieval.postgres.test.ts
pnpm test:integration --spec=row-security.postgres.test.ts
pnpm exec vitest run apps/api/src/content/search.test.ts packages/db/src/encryption/content-crypto.test.ts packages/db/src/encryption/content-encryption.test.ts
```
