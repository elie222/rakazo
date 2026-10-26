# Routine mention reads

Base: upstream `main` at `4f2d0616fe15a5aaa7ec7a78949054783385147d`.

Web already caches routines per bot. Mobile already waits for the first mention
request and limits routine reads to four at a time. Those behaviors remain useful;
this change reduces the separate HTTP requests needed to load a large roster.

The web hook retains the existing scoped `routines.list` query keys and cached data.
Simultaneous query functions share a batch. A later one-bot invalidation still uses
the original per-bot route, and a failed refresh keeps the previous cache value.
Mobile creates the same batcher only after activation and keeps its captured request
context, scope checks, partial-failure retry and cancellation behavior.

The authenticated `routines.listForMentions` route accepts at most 100 bot IDs. One
ownership query uses the same user, space and non-archived predicates as `getBot`.
It reuses `listRoutinesDto`, including its database order and editable flags, with
at most four reads in flight. Aborted requests stop launching queued reads. Omitted
parents and failed/older-server batch requests fall back to the existing endpoint;
per-bot failures remain separate, so a web query does not lose its cached value.
Small rosters retain the original bounded reads. Larger inputs use sequential
batches and do not create unbounded server fan-out.

## Controlled comparisons

```sh
pnpm exec vitest run packages/core/src/routine-mention-batcher.test.ts \
  apps/api/src/routine-mentions.test.ts \
  apps/mobile/lib/thread-mention-catalog.test.tsx \
  apps/web/src/pages/shell/use-composer-mentions.test.tsx
pnpm test:integration -- --spec=authorization
```

The HTTP-router comparison uses 100 bots and the actual current per-bot handler as
its baseline, with mocked database reads. Results and per-bot order match. Routine
HTTP calls decrease from 100 to one; database reads decrease from 200 to 101. The
100 routine reads are deliberately retained rather than changing their ordering.

The real web hook batches its 100 routine reads, preserves cached first-frame data,
and refreshes only one bot after a one-bot invalidation. The real mobile hook waits
for activation, then makes three suggestion RPCs rather than 102 (one routine batch
and the existing two connector requests). These new client regressions fail on the
unchanged upstream hooks. Smaller/reused rosters and differently timed requests
save fewer calls. This is a deterministic request-count comparison, not a claim
about live-network latency or database execution time.

Other tests cover bounded legacy fallback, partial failures, query cancellation,
large-roster chunking, native session/server/space changes, and preserving pinned
request context. PostgreSQL authorization tests compare the old and new responses
for same-space users, different spaces and archived parents, and include the new
route in exhaustive unauthenticated-call coverage.
