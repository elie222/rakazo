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
| Vision acceptance | Product API, Pi, real vision model, E2B desktop | Fixture website | `pnpm test:computer` |

Default and PR tests never require paid inference. The nightly topology job also
runs the Docker replay. Real-model quality runs are separate nightly evidence,
not a deterministic PR gate. Missing live credentials mean **not run**, not a
passing model evaluation.

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

These are authored synthetic scenarios, not recordings of a successful live
model run. To add a regression from a real failure, reduce it to synthetic data,
remove credentials and unstable identifiers, and encode meaningful state
transitions. Resolve fresh page references instead of replaying old reference
IDs. For coordinate scenarios, control the viewport and fixture layout.

## Live computer acceptance

Run a vision-capable model through OpenRouter against a real E2B desktop:

```bash
COMPUTER_E2E_MODEL=openai/gpt-5.6-luna pnpm test:computer
```

This opt-in test requires `OPENROUTER_API_KEY` and `E2B_API_KEY` and incurs
inference and sandbox usage. It checks visual observation, a real browser click,
terminal access and exact file contents. It then destroys the sandbox outside
the app and calls `computer/recover`, requiring a new sandbox with the saved
file restored. `computer/boot` returns the stored running state and does not
request recovery from an externally deleted sandbox.

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

Nightly runs accept the same connection JSON through the `MODEL_CONNECTION_JSON`
repository secret, including compatible endpoints. When absent, they reuse the
existing OpenRouter canary credential and configured default model. Connection
credentials are available only to the prerequisite and live execution steps.

The suite covers artifacts and calculations, inbox grounding and injected
instructions, precise and read-only CRM operations, approval payloads, uncertain
writes, durable preferences, workspace memory isolation, saved taught playbooks,
and GitHub release monitoring. The 15 cases include a saved playbook applied to
new input; they do not evaluate visual teaching or native mobile recording.

The fake sandbox supports file operations and a limited shell emulator. It does
not execute arbitrary scripts, so a failure involving shell execution needs
confirmation in the real Docker or live computer lane. Release monitoring
checks a daily schedule and a newly introduced release; unchanged-release
notification deduplication is not covered by this suite.

Grading reads files, service records, recorded effects and persisted product
state. A model's claim of completion is not sufficient. Cases do not receive
repair prompts or coaching after a failure. Multi-turn setup and fresh-context
checks are explicit parts of the scenario.

Reports under `test-report/evals/` contain per-case success counts, first trial
success, autonomous success rate, latency, tool counts, criteria, redacted
traces and artifacts. Unavailable token or cost measurements remain null.
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
