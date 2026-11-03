# Run dispatch and response timing

A run starts in the process that makes it due. When the API commits a message, a new
bot's greeting, or an answer, `RunJobPublisher` records the run's wake time and
`RunStarter` begins executing it in that same API process as an independent task;
the HTTP request returns at once and clients follow the reply through realtime.
Routines, bot-to-bot messages, webhooks and retries start the same way in whichever
process creates them. No queue, scan, shared slot or notification sits between a
due run and its start, so one slow or stuck run never delays another. A run due
later starts from a timer in the process that scheduled it.

Each start claims the run through the executor's atomic lease and fence checks, so
however many API and worker processes run, a run executes once. Model streams and
tools run independently after durable ownership and heartbeats are established.

A process that is shutting down or lacks memory headroom hands the run over: it
publishes the run id on the realtime connection and a worker takes it. Shutdown
requeues in-flight runs the same way, so the replacement process resumes them
within moments of a deploy.

Recovery is never on the path a new run takes. Each worker scans for runnable rows
at startup and every five seconds and starts any it finds: a run whose process died,
an expired execution lease, or a lost start or handover.

A bot uses its computer for one run at a time. A message sent while a run is going
steers that run instead of waiting. Background runs that need the computer while
another run of the same bot holds it stay queued; the run that releases the computer
starts the next one waiting, and recovery leaves them untouched until then.
Execution timing starts after computer ownership is acquired.

Graphile remains responsible for scheduled and maintenance jobs. Those jobs can
create runs, which use the same direct dispatch path. Legacy run deliveries remain
supported during rolling upgrades and drain safely against the same database
claims. Pending legacy retry times are carried into the new run schedule by the
additive migration. A compatibility trigger also stamps retry backoff when an
older worker requeues after the migration; explicit new-worker schedules take
precedence. Remove that trigger only after those older releases have drained.
Embedded installations using the memory job driver retain their
existing dispatch and recovery behavior.

## Timing

Structured logs emit `run.execution_started`, `run.first_response`, and
`run.finished`. Timing fields contain durations in milliseconds:

| Field | Meaning |
| --- | --- |
| `run.pre_run_wait_ms` | Source message to run creation, including steering held behind earlier work. |
| `run.queue_wait_ms` | Run creation to its first execution start. |
| `run.first_response_ms` | Source message to first persisted visible reply text or reply card. |
| `run.total_ms` | Source message to run completion or failure. |
| `run.execution_wall_ms` | First execution start to completion, including retries and human waits. |

These are run-level measurements. Multiple steering messages can share one run;
its selected source message defines the timing origin. When a run has no source
message, its creation time is the origin. Missing start,
response, or completion timestamps omit the corresponding duration rather than
reporting zero. Use `run.trigger` and `run.outcome` to distinguish interactive,
scheduled, successful, and failed work. Use each run's first-response record for
response latency distributions and its terminal record for total duration; do not
mix timing fields repeated on different lifecycle events as independent samples.

The first response timestamp is persisted in the same transaction as its output
and is preserved across attempts, restarts, and resumes. Streamed text, final-only
replies, message tools, and reply cards count. Reasoning, working placeholders,
activity-only progress, and hidden metadata do not. Timing adds no message content
or new personal identifiers to logs. A timing-log read failure cannot fail an
already committed operation.

These are server-side availability measurements. They do not measure network
delivery or rendering on a user's device. Client delivery/render timing would need
a separate acknowledgement.

Recurring timer routines mark their origin durably and keep one pristine pending
catch-up run for the same routine, prompt, thread, and model selection. A later
tick reuses that pending work and advances the next scheduled tick, preserving
any computer retry delay. Already started runs, manual tests, explicit retries,
one-shot schedules, and change/event-triggered runs remain separate. Unmarked
older firings are preserved: a scheduled firing event alone cannot distinguish
recurring work from a one-shot whose routine was later edited.
A bounded pass cancels redundant marked timer rows with no attempts, effects,
output, steering, checkpoint, or live computer ownership, preserving historical
rows and terminal events. The `routine.coalesced` log records reuse without
another `routine.fired` event.
A timer run whose first start is more than 15 minutes after the most recent occurrence
due by then (counted from the occurrence in its marker) tells the agent both
times in the routine's timezone, so a catch-up after downtime can adapt instead
of assuming it is still the scheduled time. Late runs are never skipped.
Committed timer runs and their advanced schedules remain intact when publication
fails. Recovery repairs delivery for every driver; a notification failure never
rolls back work that another tick or dispatcher can already own.

Interactive work is scanned before scheduled/reaction work in each bounded pass.
When memory admission declines a run, dispatch leaves it durable and continues
scanning instead of waiting in a dispatch slot. Memory admission independently
checks available physical memory and unused JavaScript heap space against the
same small attachment startup buffer. External buffers are not counted against
the JavaScript heap limit, and live-run counts do not set a concurrency limit.
Notifications and periodic recovery reopen completed lanes without restarting
active pagination. Active model streams have no new duration limit.

`run.admission_wait` and `run.admission_resumed` identify a capacity episode and
its duration without logging every retry. Independently, every thirty seconds the
worker reports `run.queue_delayed` as an error when an interactive run has been due
and unstarted for at least thirty seconds, measured from the later of creation and
wake time. Runs waiting for their own bot's earlier run on its computer, retry
backoff, future retries and scheduled work do not count. The error carries
`queue.delayed_runs`, `queue.oldest_wait_ms`, `queue.oldest_run_id`, and the
reporting process's health: `worker.active_runs`, `db.pool.total`, `db.pool.idle`,
`db.pool.waiting`, `event_loop.delay_max_ms` and `event_loop.delay_p99_ms`.
`run.queue_recovered` marks recovery. These checks do not block dispatch.

For optional Axiom monitoring, alert when the following query returns any events
in the last two minutes (use the deployment's configured dataset):

```apl
['YOUR_DATASET']
| where message == "run.queue_delayed"
| summarize delayed = count()
| where delayed > 0
```

The application emits the signal; notification routing belongs in the deployment's
monitor configuration. No hosted monitoring service is required for dispatch.
