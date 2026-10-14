# Leave a queued run's retry in place

## Title

Leave reconciliation from resetting a backed-off run job

## Body

### Why

A queued run already has a `run.continue` job while it waits out failure backoff. Reconciliation enqueues that same key again. The queue's default for a key is replace, which clears the attempt count and the scheduled time, so the worker's cap never holds and the run starts again immediately.

### Repro

Enqueue `run.continue` with a replacement key and a future `availableAt`. Enqueue the same key again with `keepExisting` omitted. The first job is cancelled and the second runs now, with a fresh attempt count. The same replacement happens on every reconcile of a queued run.

### Fix

`BackgroundJob` accepts `keepExisting`. Graphile then uses `jobKeyMode: "unsafe_dedupe"`, which leaves an existing job alone, including one that has used its attempts. The in-memory queue does the same for a keyed job that is still scheduled. Reconciliation passes the flag for queued runs. An explicit continue still replaces.

### Tests

- `leaves a keyed job in place when asked to keep the existing one`
- `restores queued runs and near-due routines with stable replacement keys`

## Evidence

Test `InMemoryJobQueue > leaves a keyed job in place when asked to keep the existing one`.

Before: the second enqueue replaced the delayed job. After one second the handler had already run once, with `runId` `pulled-forward`.

After: that handler was not called after one second. After the original five-second delay it ran once, with `runId` `backed-off`.

`job-reconciler` and `wakeup` unit tests passed. Typecheck passed for `@rakazo/adapter-kit` and `@rakazo/adapters`. Biome passed on the touched files.
