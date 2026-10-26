# Event refreshes

Base: upstream `main` at `4f2d0616fe15a5aaa7ec7a78949054783385147d`.

Terminal and waiting-input event callbacks start a new snapshot read for every event.
The web bot and group callbacks also refresh the sidebar on terminal events. These
reads bypass query-cache deduplication: the sidebar calls `spaces.list`, and thread
snapshots call `threads.get` directly. The existing response epochs protect commits
but do not prevent requests from starting.

Each subscription now owns a snapshot coalescer; web subscriptions also own a
sidebar coalescer. An invalidation during a read requests one trailing read. Events
during that trailing read can request another, so the last invalidation is retained.
There is no timer. Teardown discards queued work. Initial loads, recovery, direct
actions, polling, archived roster reads and computer refreshes keep their existing
paths. Mobile rechecks session and history guards before each queued read.

## Reproduction

```sh
pnpm exec vitest run packages/core/src/refresh-coalescer.test.ts \
  apps/web/src/pages/shell/use-thread-sync.test.tsx \
  apps/mobile/lib/thread-foreground.test.ts
```

The web tests mount the actual bot/group hook, capture its subscription callbacks,
and defer the RPC response. The mobile test mounts the actual native subscription
hook with a deferred snapshot. One event starts a read; another 100 events arrive
before its response. The unchanged upstream implementations start 101 snapshot
reads in each of these three cases. With this change they start one, then one
trailing read after its response. Web sidebar calls also share their in-flight read.

These are deterministic request-count measurements at the RPC boundary, not a
live-server latency benchmark. Real savings depend on event timing and request
latency. The tests also cover applying the snapshot, history-window preservation,
foreground cursor replay, dropping queued work on teardown and session changes.
Core tests cover failure/retry, invalidations during a trailing read, independent
queues and invalidation at completion.
