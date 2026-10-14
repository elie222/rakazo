# Keep a backed-off run job unless its attempts are used up

## Title

Keep a backed-off run job, and replace one that has used its attempts

## Body

### Why

A queued run already has a `run.continue` job while it waits out failure backoff. Reconciliation enqueues that same key again. The queue's default for a key is replace, which clears the attempt count and the scheduled time, so the worker's cap never holds and the run starts again immediately.

Deduping every existing row fails the other way. Graphile's `unsafe_dedupe` only bumps the row's revision, so a job with `attempts >= max_attempts` stays exhausted, the worker will not pick it up, and the run remains queued.

### What

`BackgroundJob` accepts `keepExisting`. The publisher loads that key's `attempts` and `max_attempts`. While attempts remain, Graphile uses `jobKeyMode: "unsafe_dedupe"`, which leaves `attempts` and `run_at` alone. When the job is exhausted or missing, the publisher uses the default replace, which inserts the job or sets `attempts` back to 0 and applies the new `run_at`. The in-memory queue keeps a keyed job only while that job still has attempts left, and otherwise enqueues a fresh one. Reconciliation passes the flag for queued runs. An explicit continue still replaces.

### How tested

`InMemoryJobQueue` covers a keyed job in backoff (attempt count and `run_at` stay), an exhausted keyed job (enqueued again with attempts reset), and a missing key (enqueued).

`GraphileJobPublisher` covers the same three outcomes against a stand-in of graphile-worker 0.17.3's job-key conflict: dedupe while attempts remain, replace when `attempts >= max_attempts`, and insert when the key is absent. With a database configured, the PostgreSQL contract reads `attempts` and `run_at` from `graphile_worker._private_jobs` for those three cases.

Before this change, every `keepExisting` enqueue used `unsafe_dedupe`, so an exhausted row was left in place.

Also covered by `restores queued runs and near-due routines with stable replacement keys`.

Checked with the adapter job tests above and typecheck for `@rakazo/adapter-kit` and `@rakazo/adapters`.
