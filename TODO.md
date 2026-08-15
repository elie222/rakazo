# Engineering TODO

These are deliberate follow-ups from the realtime and background-job architecture review. They are
not required for the initial self-hosted setup, which remains Postgres plus Graphile Worker.

## Reliability

- [ ] Make terminal run state, the final durable message, and its product event one fenced atomic
      database operation. The current lease renewal makes stale finalization unlikely, but a worker
      that loses its lease at exactly the wrong point could still publish before discovering it no
      longer owns the run.
- [ ] Add real-Postgres contract tests for the Graphile publisher/worker host, including graceful
      shutdown, delayed replacement, cancellation, and retry behavior.
- [ ] Add a real-Postgres LISTEN/NOTIFY smoke test covering listener reconnect and missed-event
      catch-up. Unit tests already cover the state machine and race conditions.

## Scale when measurements justify it

- [ ] Paginate durable thread messages and exports so very long threads do not require loading the
      entire history in one snapshot.
- [ ] Add cursor-based reconciliation or a dispatch timestamp so more than the oldest 100 recoverable
      jobs drain with a bounded delay.
- [ ] Elect one reconciliation leader with a Postgres advisory lock when running many worker replicas.
      Multiple reconcilers are correct today, but they perform redundant scans.
- [ ] Keep Redis as an optional future `RealtimeFanout` adapter only if production measurements show
      PostgreSQL notification fanout is the bottleneck. Do not make Redis part of the base setup.

## Cleanup

- [ ] Move the duplicate API/worker root-environment loader into a small shared Node-only utility when
      another Node entrypoint needs it; avoid creating a package solely for this duplication.

## Explicit non-goals

- D1 and Cloudflare-specific persistence are not planned for the portable base architecture. They
  would require a separate persistence/runtime design rather than a drop-in database adapter.
