# Offline original-history and context evidence

These checks use synthetic originals, a disposable PostgreSQL database, a fake
sandbox, and a loopback model endpoint. Pi and the executor remain real. Scripted
model responses verify orchestration and outgoing context; they do not establish
that a live model will choose the right action.

The PostgreSQL test seeds 10,000 messages and captures the complete authorized
`searchHistory` query, including user, space, thread, bot and group checks. It
executes `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` with the captured SQL and bound
values. PostgreSQL uses the local GIN expression and returns the one matching
original. Two observed warm-query executions took 0.171 and 0.263 milliseconds,
with planning times of 0.346 and 0.326 milliseconds. These are illustrative
synthetic measurements, not production latency guarantees or timing assertions.
The test requires index use and the correct result without a brittle time limit.

Snapshots reuse the original-message index. Search locates a source; bounded
`read_history` pages return original-backed snapshots and linked runs, outcomes,
and artifact references. The shared index includes subagent task text as well as
completed results, so a task-only open investigation remains searchable before
any result exists. A PostgreSQL regression follows that source-less open task to
its current run status and verifies channel isolation and clearing. There is no
second summary index or generated snapshot
store. Coverage, timestamp and original-content version come from the original;
run status is read again from persisted state. The navigation test follows a
short source to a subagent conclusion, pages forward, observes an open run becoming
complete, and confirms cleared originals disappear from search. This design
requires no snapshot-creation inference and has no generated-summary maintenance
cost. Live strategy quality gates determine whether this navigation is sufficient.

Already-short loaded originals can remain directly available under snapshots and
cold cache-aware selection. Their provider-equivalent estimate must fit at most
16,384 tokens and one quarter of the resolved budget remaining after instructions,
tools and output reserve. Larger history keeps the recent-eight plus bounded
navigation path; the shared full-context budget still applies. An actual product
regression uses the ordinary 100-message seeded fixture across three turns under
both policies: the old rare label and pending-approval constraints appear in every
model request, with zero retrieval tools, exactly three model calls and no
compaction generation. This avoids paying another lookup for short originals
without claiming that the live-model cost gate is already met.

The paging regression retrieves every one of 50 linked runs, 100 artifacts and
30 outcome messages. It reconstructs a long original containing Unicode and
newlines through exact text offsets. Complete backend JSON stays within 10,000
bytes. An actual native-group executor loop retrieves 101 authorized artifacts,
including a peer bot's result; separate database checks deny nonmembers and other
users. Private channel sources and cleared channel-linked outputs remain excluded.
Quoted, newline and numeric fake credentials are redacted before model requests.
The long group paging fixture explicitly configures a 160,000-token synthetic
window and 4,096-token output reserve; complete navigation metadata peaks at
1,713 bytes per page. Unconfigured compatible models retain the conservative
16,384-token window. Metadata that cannot fit that window remains a valid retry
response rather than corrupt JSON; separate small-window tests cover that failure
and successful within-message cursor navigation.

A saved bot-memory constraint and an open scratchpad item are supplied to the
actual model endpoint after 100 large old messages exceed active-context allowance.
The fixture checks both constraints on the initial call and following history and
file tool calls, confirms old filler has dropped, and inspects the persisted
proposal file: batch size 37 and approval pending. The scratchpad remains open.
This proves state availability and the resulting scripted workflow, not live-model
obedience to arbitrary historical constraints.

Context selection preserves complete JSON when shortening structured tool
results. History excerpts retain original IDs, offsets and next-page metadata;
metadata that cannot fit produces valid retry JSON or an explicit context-budget
failure. Search excerpts are actual original slices without display ellipses. Search also
stops at the server-captured boundary before the active question: neither current
question text, steering, nor newer outputs can masquerade as an earlier discussion.
A model-supplied cursor cannot widen this boundary. Explicit authorized reads and
live linked outcomes remain available, and older search pages remain reachable.
Search results echo the normalized query, report coverage only for the requested
query and range, and provide ready-to-call `nextSearch` arguments alongside the
legacy cursor. A narrower empty result cannot describe a broader query as exhausted.
An actual product/Pi regression inspects the broad Aurora page, performs an empty
narrower lookup, follows the original continuation with its date filters, and reads
the older source fact. The earlier partial response remains available on the wire.
This scripted endpoint proves payload and continuation availability; whether a
live model chooses to continue is qualified separately.
An actual Pi request in a 4,096-token configured window follows a shortened text
cursor and reads the next original slice. A second regression runs twelve dependent
large JSON diagnostics under all three candidate policies: cursors stay intact,
old tool groups drop together, the current pending-approval constraint remains,
and exactly twelve tool calls complete. Omitted diagnostic text is marked as
unavailable evidence.

A PostgreSQL product regression reuses the 1,000-message long-loop eval fixture,
its prepared summary, full product instructions and `EvalServices` connector with
the shared retrieval default, a 1,000,000-token window and 4,096-token output allowance. The loopback
endpoint parses each outgoing diagnostic result and chooses its actual next
cursor, rather than supplying predetermined follow-up arguments. All twelve
segments complete. Structured shortening reduces the latest verbose result from
about 25,660 to 6,596 bytes with an explicit omission marker. Prior results are
shortened to at most 1,024 bytes while preserving complete JSON and cursor controls;
all twelve completed segments and their matching wire calls remain visible in
the final request. Every request retains the current instruction not to deploy.
Synthetic assistant prose accompanies every tool call to reproduce growing
active-loop context without capturing real model reasoning. Selected-context
estimates grow from 28,786 to 123,517 tokens, exceeding the former additional
32,768-token quota while fitting the resolved window and output reserve. The
endpoint still follows all twelve actual cursors with no lost starting segment.
The model-call observer reserves against its conservative preselection estimate
(411,500 tokens on the last synthetic call), while context-decision telemetry
reports the selected request estimate (123,517). These estimates are distinct;
neither replaces reported provider usage or proves actual billing savings.
This verifies the product path and
available progress evidence, without claiming live-model reliability.

Omitted product strategy now resolves through the shared retrieval constant;
explicit strategy overrides preserve their behavior. Actual Pi requests with
both history tools and a dispatch backend have identical provider messages and
tool definitions under omitted and explicit retrieval strategies. Default main
and delegated loops obey the same budget. A standalone request without both
usable history tools retains fitting originals within the model budget rather
than applying an arbitrary recent-eight cutoff; it adds no snapshot catalogue or
unavailable history-tool hints. Product fixtures exercise the default with group
paging, the twelve-step loop, and 100/1,000-message source-verified follow-ups.

The existing compaction regression performs two successive summary cycles and
verifies the second summary includes the first and advances coverage correctly.
Candidate policies skip queued and newly scheduled message-count compaction;
legacy `current` remains available to reproduce the baseline. Expiry itself makes
no inference call. An oversized mandatory request or image that exceeds the
configured estimate fails before provider invocation. Pi uses bounded header
inspection and a dimension-based planning estimate for static PNG, JPEG, and
WebP images in both parent and delegated calls, including pre-call reservations.
GIF and animated WebP parsing count full canvas tiles for every frame within the
shared attachment size limit; APNG uses declared animation frames and includes
the default image when it is separate. Malformed and unknown metadata retain the
encoded-byte fallback. This
planning heuristic is separate from provider-reported billing and is not a
universal vision-token upper bound. Offline HTTP and delegated screenshot tests
exercise valid PNG and GIF images larger than 1 MB within a 128k model window; computer
replay also uses that normal window rather than an oversized workaround.

The history CLI's optional `--wire-diagnostics` flag records allowlisted cursor
controls for the synthetic long-tool-loop cases after SDK serialization. It
retains neither prompts nor request identifiers, credentials, or URLs. An offline
Pi HTTP test verifies all twelve dependent tool results, including the terminal
null cursor, survive serialization and context selection. This makes future live
failures diagnosable; it does not establish the cause of an earlier failed run.

Reproduce the ordinary offline checks with:

```sh
pnpm exec vitest run \
  packages/testkit/src/history-context.test.ts \
  packages/adapters/src/context-selection.test.ts \
  packages/adapters/src/runtime-context.test.ts
```

For database checks, use a disposable migrated synthetic database and run the
history retrieval unit, PostgreSQL, and executor tests with `VERIFY_DATABASE=1`
and `DATABASE_URL` set to that database. Live answer quality, changed-decision
reliability, comparative cost, and cache effectiveness are reported separately.
