# Leave a queued run's retry in place

## Title

Leave reconciliation from resetting a backed-off run job

## Body

### Why

A queued run already has a `run.continue` job while it waits out failure backoff. Reconciliation enqueues that same key again. The queue's default for a key is replace, which clears the attempt count and the scheduled time, so the worker's cap never holds and the run starts again immediately.

### What

`BackgroundJob` accepts `keepExisting`. Graphile then uses `jobKeyMode: "unsafe_dedupe"`, which leaves an existing job alone, including one that has used its attempts. The in-memory queue does the same for a keyed job that is still scheduled. Reconciliation passes the flag for queued runs. An explicit continue still replaces.

### How tested

`InMemoryJobQueue > leaves a keyed job in place when asked to keep the existing one` failed before the change: the second enqueue replaced the delayed job, and after one second the handler had already run once with `runId` `pulled-forward`. After the change, that handler was not called after one second. After the original five-second delay it ran once, with `runId` `backed-off`.

Also covered by `restores queued runs and near-due routines with stable replacement keys`.

PR CI: `pnpm lint` (including the translation-catalog check), `pnpm check`, `pnpm build` with the Electron preload smoke, `pnpm test`, `pnpm test:integration`, and `pnpm test:e2e`.
