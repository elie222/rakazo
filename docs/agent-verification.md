# Agent verification

Generated JSON reports are preserved locally under ignored `test-report/evals/archive/`, with a second backup outside the disposable worktree. They are not tracked documentation or repository downloads; maintained findings and synthetic fixtures remain in source control. Report references below identify local archived evidence, including every original failed and partial run.

Rakazo separates deterministic execution regressions from real-model task quality.
A scripted response can prove that a tool call executes correctly; only a real
model can demonstrate that it chooses a useful action for a natural request.

| Layer | Real components | Stand-ins | Command |
| --- | --- | --- | --- |
| Existing fast tests | Product functions and contracts | Scripted agent, services, sandbox | `pnpm test` |
| Pi protocol regressions | Pi agent loop, HTTP/SSE parsing, tool dispatch | Loopback model endpoint, tool effects | `pnpm test:pi` |
| Pi product journey | API, saved model connection, Postgres, executor, Pi | Model endpoint, sandbox, connectors | `pnpm test:integration` |
| Computer replay | Pi, browser tool handlers, page state | Model endpoint, browser and sandbox | `pnpm test` |
| Docker computer replay | Pi, supervisor, Chromium, page helper, downloads and files | Model endpoint, local fixture website | `pnpm test:computer-replay` |
| Agent quality | Product API, Postgres, executor, Pi, real model | Sandbox and connected services | `pnpm test:evals --live ...` |
| Vision acceptance | Product API, Pi, real vision model, Box or E2B desktop | Fixture website | `pnpm test:computer` |

Default and PR tests never require paid inference. Nightly runs only the web
tests with emulated providers. Docker topology and browser replay have a manual
workflow; hosted sandboxes and real-model quality runs require an explicit local
command. Nightly verification never starts computer sandboxes or requests model
or sandbox credentials.
Missing live credentials mean **not run**, not a passing model evaluation.

## Deterministic Pi tests

`packages/testkit/src/model-emulator.ts` serves a loopback OpenAI-compatible
stream through Rakazo's existing generic connection. It does not replace Pi.
Each step validates the actual request before streaming a response, and tests
must assert that all expected steps were consumed without unexpected requests.
The next request must contain the tool result from real execution.

Coverage includes fragmented tool arguments, tool failures, rejected model
requests, interrupted streams, cancellation of a quiet stream, and concurrent
connections. The Postgres journey also verifies the persisted run, message and
file through the product boundary.

## Computer replay

The synthetic contacts-export scenario navigates a fixture page, observes the
computer, uses fresh element references to open an export dialog and download a
CSV, then reads the artifact. Independent checks require the exact CSV and one
export. Invalid or stale clicks and cancellation cannot create the artifact.

The emulator models page state; it does not advance just because another tool
was called. The Docker lane executes the same scenario against real Chromium
and the production supervisor/page-browser helper. It checks a real screenshot
and browser-created file. The generic compatible model fixture is text-only;
Pi's image-omission behavior is checked explicitly. Vision interpretation is
covered by the separate real-model acceptance test.

```bash
pnpm sandbox:build
pnpm test:computer-replay
# Or use an already built image:
pnpm test:computer-replay --image=rakazo/computer:local
# If Docker has exhausted its automatic address pools, choose an unused subnet:
pnpm test:computer-replay --subnet=<unused-private-cidr>
```

Docker replay does not open Electron windows, use model credentials, or attach
to an existing browser. It owns and cleans up its test resources. It exercises
the runtime and computer boundary; it does not claim UI, approval, or database
executor coverage.

The suite includes authored failure scenarios and a contacts-export recording
captured with Luna through OpenRouter against real Docker Chromium. Replay uses
the HTTP model emulator with real Pi and resolves fresh page references. Tests
cover cancellation, a transient download failure, workspace restoration, and
an interrupted model stream after export without duplicating the export.
Separate Postgres integration tests verify that computer actions wait for
approval, execute the approved payload once, and have no effects after denial.

To capture another successful run manually:

```bash
# Requires OPENROUTER_API_KEY; incurs inference usage, with a local Docker sandbox.
pnpm test:computer-replay --image=rakazo/computer:local \
  --live --record=new-fixture.json
```

The recorder accepts only this synthetic contacts scenario. Its closed
vocabulary retains action names, known button labels and success/error outcomes;
it excludes model prose, raw responses, URLs, credentials, IDs, element refs and
screenshots. A new fixture is written only after both live execution and an
immediate offline replay produce the exact CSV and exactly one export. Failed
attempts print only the sanitized decisions and do not publish a fixture.

This records semantic browser actions, not coordinate or vision decisions.
Box currently lacks the page-browser capability used here, so this capture uses
local Docker. Box remains the default for the separate screenshot/coordinate
acceptance journey. One successful captured run demonstrates replay coverage;
it does not measure the live model's reliability.

## Live computer acceptance

Run a vision-capable model through OpenRouter against a real Box desktop:

```bash
COMPUTER_E2E_MODEL=openai/gpt-5.6-luna pnpm test:computer
# Run the same checks against E2B when provider-specific verification is needed:
COMPUTER_E2E_MODEL=openai/gpt-5.6-luna pnpm test:computer --sandbox e2b
```

Box is the default regardless of the application's sandbox setting. This opt-in
test requires `OPENROUTER_API_KEY` and the selected sandbox's credential
(`BOX_API_KEY` or `E2B_API_KEY`) and incurs inference and sandbox usage.
It checks visual observation, a real browser click,
terminal access and exact file contents. It then destroys the sandbox outside
the app and calls `computer/recover`, requiring a new sandbox with the saved
file restored. `computer/boot` returns the stored running state and does not
request recovery from an externally deleted sandbox.

Both providers run the same assertions. This journey does not cover PTY sessions
or multiple screens, which Box does not support. Provider conformance tests
remain separate. Live runs retain error logs to diagnose provider failures.

## Real-model quality

List the cases without inference:

```bash
pnpm test:evals --list
```

Run through a normal provider connection, referring to an existing credential
variable rather than placing a key on the command line:

```bash
pnpm test:evals --live --provider openrouter --model <model-id> \
  --api-key-env OPENROUTER_API_KEY --trials 3
```

`--connection <private-json-file>` also accepts the shared `models/connect`
shape, including a generic compatible endpoint. Never commit that file. Use
`--case <case-id>` to select a regression. Each run provisions isolated Postgres
and synthetic services; it does not use production application data. Each trial
uses fresh accounts and services. The runner disables its routines and cancels
its work before proceeding; cleanup failure leaves remaining trials not run.

Live evaluations run only through an explicit local CLI invocation. They are
not scheduled by the nightly workflow.

The September 2026 Luna/OpenRouter baseline passed all 15 cases over three
trials each (45/45) after correcting the harness. The initial run passed 41/45:
one shell command was falsely reported successful by the fake sandbox, and
three correct outcomes failed overly narrow wording checks. Regression tests
cover those fixes; the original report remains separate from the corrected run.

The suite covers artifacts and calculations, inbox grounding and injected
instructions, precise and read-only CRM operations, approval payloads, uncertain
writes, durable preferences, workspace memory isolation, saved taught playbooks,
GitHub release monitoring, and a Slack-to-Salesforce-and-Zendesk customer update.
The recorded baseline above covers the original 15 cases; the current 16-case
suite also verifies that a real model selects matching records across two local
service emulators and posts a grounded reply to the originating Slack-like DM.
It does not evaluate visual teaching or native mobile recording.

Keep compact scenario seeds, generators and grading criteria in this repository
so contract changes are reviewed together and failures reproduce from one
commit. Fixtures must be synthetic. If a future corpus is too large for the
repository, publish it as a versioned artifact pinned by immutable digest and
retain a small offline conformance fixture here. Do not import third-party eval
data unless its redistribution terms are explicit and compatible.

The eval sandbox executes file tools but returns an explicit error for model
shell commands instead of pretending to run them. If outcome checks fail after
that limitation is encountered, the trial is attributed to the harness. Confirm
shell-dependent outcomes in the real Docker or live computer lane. Release monitoring
checks a daily schedule and a newly introduced release; unchanged-release
notification deduplication is not covered by this suite.

Grading reads files, service records, recorded effects and persisted product
state. A model's claim of completion is not sufficient. Cases do not receive
repair prompts or coaching after a failure. Multi-turn setup and fresh-context
checks are explicit parts of the scenario.

Reports under `test-report/evals/` contain per-case success counts, first trial
success, autonomous success rate, latency, tool counts, criteria, redacted
traces, artifacts and redacted memory evidence. Tool and usage totals retain
records across conversation clearing; clearing history cannot reset a trial’s
tool budget. Unavailable token or cost measurements remain null.
Failures distinguish agent outcomes, product errors, provider failures,
harness failures and incomplete runs. Read the category and evidence before
attributing a red run to a prompt change. Several trials establish an initial
baseline, not a statistically precise reliability estimate.

The injection case checks the requested artifact and forbidden service effects.
It does not grade every claim in free-form explanatory prose; quoted or denied
injection warnings must not be mistaken for compliance with the injection.

Keep functional criteria deterministic. Add a model judge only for a quality
that cannot be graded directly, with a versioned rubric and human calibration.
Do not let a judge override forbidden effects or missing artifacts.

### Long conversation and cost evals

List seeded long-chat cases without a database or model connection:

```sh
pnpm exec tsx packages/testkit/src/cli/evals.ts --suite history --list
```

Run the original context strategy explicitly with a disposable database and an
explicit generic model connection. Connection and pricing JSON files must stay
outside tracked content. Pricing requires `source`, `version`, and USD per million
rates for `input`, `output`, `cacheRead`, and `cacheWrite`. Optional `longContext`
rates use the same four fields plus `thresholdTokens`. Optional `cacheWrite1h`
prices one-hour writes separately; these tokens are a subset of all cache writes.

```sh
pnpm exec tsx packages/testkit/src/cli/evals.ts --live --suite history --strategy current --connection /tmp/eval-connection.json --pricing /tmp/eval-pricing.json --trials 1 --spend-cap-usd 5
```

The default live cap is USD 5. Every runtime model call reserves its estimated
maximum spend before inference, including subagent and summarization calls.
Concurrent reservations share one budget; unavailable usage retains the reserved
estimate. Unknown pricing prevents live execution. This is an estimate guard,
not a provider billing guarantee. Cache writes are priced conservatively for
reservations and by their actual reported buckets for reports. Reasoning tokens
are included in output, never charged twice.

Total tokens require an explicit upstream total or a complete known breakdown of
uncached input, output, cache reads, and cache writes. SDK totals synthesized from
missing cache fields are not proof of complete usage. When that breakdown and a
reported total are unavailable, settlement retains the reservation. An observed
one-hour write without pricing in its applicable context tier also retains the
estimate and prevents further scheduling until pricing is resolved.

Reservations use the highest rates across pricing tiers reachable by the upper
token estimate; actual usage may remain in a more expensive base tier. Explicit
one-hour writes require a known applicable one-hour price before inference.
Omitted connection cache controls use the audited SDK short default, so a hidden
SDK environment setting cannot silently enable long retention. This default does
not guarantee a cache hit or an exact expiration time.

History fixtures seed 100, 1,000, and 10,000 original messages directly without
inference. They cover facts, paraphrases, dates, superseded decisions, open work,
ambiguity, absence, durable constraints, injected historical instructions,
oversized input, stale compaction coverage, and invalid summaries. Cases report
factual checks and forbidden external effects; they do not grade prose quality.
The original strategy includes the stable-guidance-first prompt ordering change.

Reports record the code revision, working diff hash, fixture version, strategy,
pricing provenance, token buckets, cache hit rate, model/tool calls, and cost by
operation. A missing measurement stays null. Cache hit rate is cache reads divided
by eligible uncached input plus cache reads plus cache writes. Eligibility requires
a configured minimum cache size or observed reuse/write evidence; unknown
eligibility and a zero denominator stay null. First response means the first persisted streamed text event after run
creation, falling back to the final persisted bot-message timestamp when no text
streamed; tool and activity events are excluded. Trial latency includes fixture
setup and cleanup. Background due work is awaited before final accounting;
cleanup must stop remaining scheduled and active work before further trials.


Compare strategies in one process so all trials and concurrent calls share one
spend cap. The order rotates deterministically within each case and trial; the
provider's cache state is uncontrolled. `current` preserves the original history
window and summary behavior; the other strategies permit history retrieval.

The selected product default is recent context with original-history retrieval.
Both retrieval and snapshots passed the same 54-workflow candidate qualification;
retrieval had the lower observed full workflow cost. These sequential runs had
uncontrolled provider cache, so the difference is not a causal savings estimate.
Explicit `current` remains available for baseline comparisons. Standalone
runtimes without usable history tools preserve loaded originals within the model
input budget instead of advertising unavailable retrieval. The final default and
fallback source passed all 54 unchanged workflows and all 27 repeated answers,
costing USD 0.06519195 across 227 calls. Details, limitations, and preserved failed
runs appear in `docs/evals/history-findings.md` and the task checklist. That initial
qualification predates integration with Pi 0.87.1. The first current-base report,
`test-report/evals/archive/history-pr-final-qualification.json`, passed 53/54 and preserves its
pagination recall failure; it does not replace the required passing final-source
gate. Current integration checks also verify system transcript instructions and
tools reach the provider after history selection.

```sh
pnpm exec tsx packages/testkit/src/cli/evals.ts --live --suite history --strategy current --strategy retrieval --strategy snapshots --strategy cache-aware --connection /tmp/eval-connection.json --pricing /tmp/eval-pricing.json --trials 2 --spend-cap-usd 1
```

Ordinary long-history cases begin with a deterministic prepared summary that
omits rare original details while retaining common constraints and corrections.
Its generation is free fixture setup, so these cases do not measure real summary
preparation cost. Backlog, oversized-input, and invalid-summary cases are separate
bounded stress workloads. Invalid stored summaries do not simulate a provider
failure during summarization. Reports include post-run summary coverage and
queue failure counts when the loaded code supports them; counts omit error
messages and payloads. Expected recovery must be assessed against coverage and
outcomes, rather than treating every background failure as an outcome failure.

Per-call context telemetry records sanitized selection decisions, predicted
freshness, measured reuse, and cost by prediction. Unsupported retention metadata
remains unknown. History diagnostics retain only synthetic search queries,
result counts, and bounded options; original messages, credentials, and IDs are
excluded. Exclusive retrieval cost attribution covers an entire model call that
requests or consumes history tools; it does not split the call's answer tokens.

Use `--cache-probe` for four direct model calls: a fresh synthetic prefix,
identical replay, changed prefix, and changed replay. This requires an explicit
connection and pricing, shares the invocation's spend guard, and avoids database
setup. It measures observed reuse and first-response latency; it is not an expiry
test. `--cache-capabilities /tmp/cache-capabilities.json` supplies generic documented
metadata independently of credentials. Predictions remain advisory because
routing and eviction can prevent reuse. Separate invocations must receive only
the remaining approved budget after earlier reservations and charges.


Retention metadata describes the selector's prediction. In particular,
`retentionMode: none` disables inferred warmth and does not promise that the
provider disables caching or bills all input at the ordinary rate. Fake-clock
checks cover expiry transitions; live prefix replay covers immediate reuse and
changed-prefix observations. Live retention expiry remains unproven unless a
separate expiry experiment is explicitly reported.

New workflow reports also partition final durable usage into numbered steps
using run and parent-run associations. Compaction and calls without an observed
step association remain separate workflow background buckets. Reports publish
no ledger or run identifiers. The partition reconciles model-call counts and
known charges with the full workflow total; unknown incurred costs stay unknown.
This attribution does not add waits between questions or change background
scheduling. Earlier reports without `stepAccounting` cannot establish exact
first-question versus follow-up charges from the combined setup cost alone.

The partial pagination qualification was stopped after eleven passing workflows
when a source audit found an incomplete instruction-ordering reconciliation. Its
remaining 43 workflows are explicitly not run. Restored ordering is checked on
actual provider requests assembled by the executor helper; the final corrected
source must complete its own unchanged 54-workflow qualification before merge.

The restored-prefix PR qualification completed 54 workflows with 53 passing.
All twelve distant-recall trials and all 27 repeated answers passed; one strict
loop skipped segment seven and guessed an invalid cursor. The original result is
preserved in `test-report/evals/archive/history-pr-restored-prefix-qualification.json`. Its charge
was USD 0.093003835 across 248 calls, reconciled with zero reservations or
background/cleanup failures. Cumulative guarded spend is USD 1.43272518 of USD 5.
Shared opaque-cursor guidance and its actual-wire regressions address this new
failure; a full unchanged live qualification remains required before merge.

The separate opaque-cursor qualification on clean committed source `3dd01cea`
completed all 54 workflows: 53 passed. All twelve distant-recall trials and all
27 repeated answers passed; five of six strict loops passed. One loop stopped
after five reads, claiming missing continuation metadata. The raw JSON contained
its cursor, but the failed live outgoing payload was not captured; the claim does
not establish a serialization defect. The actual-wire offline loop passes without
waiving the live failure. The preserved report is
`test-report/evals/archive/history-pr-opaque-cursor-qualification.json`. Its charge was
USD 0.09108541 across 238 calls, fully reconciled with zero reservations or
background/cleanup failures. Cumulative guarded spend is USD 1.52381059 of USD 5.
The live qualification gate remains failed, so this PR must not merge merely
because CI passes. No further paid run is active.
