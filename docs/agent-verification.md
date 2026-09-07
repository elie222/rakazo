# Agent verification

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
