# Conversation context evaluation findings

Retrieval was selected as the simplest policy with the lowest observed complete
workflow charge among the qualifying policies at the comparison source. Both
retrieval and snapshots passed the same 54 workflows there. The latest paid
qualification at a later source passed 53/54, so the latest-source merge gate
remains failed. Earlier successes do not override that failure.

Generated reports are local outputs, not maintained documentation. All 30 original
JSON reports, including every failed and partial run, were preserved byte-for-byte
in ignored `test-report/evals/archive/` and backed up outside the disposable
worktree. They are no longer tracked in the current tree.
The code, synthetic fixtures, dated pricing input and this concise summary remain
tracked. Share a sanitized report deliberately when a reviewer needs one.

Saving a report does not skip evaluation execution. No eval-result reuse cache is
implemented. Safe reuse would require matching the relevant source, fixture,
grader, model and configuration fingerprints and explicitly marking evidence as
reused. Deterministic build/test caches and provider prompt caches are separate;
neither turns archived paid-model results into fresh qualification evidence.

## What was measured

The deterministic history fixtures contain 100, 1,000 or 10,000 synthetic messages.
They test distant exact/paraphrased recall, corrections, absent facts, durable
constraints, linked work, balanced clarification, three-question follow-ups and
12 dependent diagnostic reads. External effects are forbidden. Three trials per
scenario provide limited reliability evidence; no grader was weakened to turn a
failed sample into a pass.

Larger ordinary fixtures start with a free synthetic summary retaining common
facts and omitting rare identifiers. That is preparation for the harness, not
measured real-world summary production. The 100-message repeated case starts
without a summary and can measure actual compaction. Backlog and failed-summary
stress remain separate from ordinary recall.

All incurred foreground, delegated and compaction calls are counted once. Final
ledger attribution partitions foreground questions and background preparation;
known token buckets and measured charges reconcile to workflow totals. Unknown
buckets remain null. Reservations protect a shared spend cap and are not a billing
guarantee. Failed/cancelled work is charged, and cleanup failures are reported.

Fixture versions are `history-v1-seed-73`,
`history-repeated-all-turns-v2-seed-73` and
`history-balanced-clarification-v3-seed-73`. The early history-v1 label was reused
while fixture semantics evolved; compare its source fingerprint and chronology,
not the label alone. Earlier repeated graders inspected only the final reply;
the v2 repeated grader checks every reply. Original grades remain preserved.

## Qualified comparison

The two complete runs below loaded the same implementation fingerprint
`1d7d29a223911fa2900a7d26c54d4192a6b9b76a6dff20ed1c8e1258d23ad769`,
case versions and unchanged graders. Provider cache state was uncontrolled and
execution was sequential. These are observed policy charges, not causal savings.

| Complete workflow measurement | Retrieval | Snapshots |
| --- | --- | --- |
| Passed workflows | 54/54 | 54/54 |
| Charge | USD 0.068219460 | USD 0.076096435 |
| Model calls | 246 | 248 |
| Latency p50 / p95 | 9.273 / 38.978 seconds | 9.633 / 36.840 seconds |
| Ordinary 36 workflows | USD 0.030151330 | USD 0.036254290 |
| Rich loop 6 workflows | USD 0.023983145 | USD 0.025025865 |
| Clarification 3 workflows | USD 0.001781775 | USD 0.002247900 |
| Repeated 9 workflows | USD 0.012303210 | USD 0.012568380 |

Retrieval cost about 10.4% less in this sample and avoids navigation snapshots;
its p95 was slightly higher. Unknown-capability cache-aware selection is
identical to snapshots' cold policy in deterministic tests. Initial stochastic
score differences do not establish a cache-policy benefit.

## Subsequent qualification and failures

Every original report stays unchanged in the local archive. Important subsequent
runs are summarized here; they use distinct sources and cannot be silently pooled.

| Local archive report | Result | Charge | Evidence |
| --- | --- | --- | --- |
| history-current-baseline.json | 4/6 | USD 0.004304100 | Current omitted rare distant facts; includes paid short-chat compaction. |
| history-current-snapshots-qualification-partial.json | 76 attempted, 32 not run | USD 0.228789600 conservative guard | Rich-loop failure and a current timeout/cleanup failure; unknown cost retained conservatively. |
| history-snapshots-qualification.json | 50/54 | USD 0.097921115 | Strict absent-fact and balanced-v2 failures retained. |
| history-snapshots-final-qualification.json | 52/54 | USD 0.097118530 | Two paraphrased recalls abandoned available history pages. |
| history-adaptive-full-qualification.json | 53/54 | USD 0.076252385 | Third repeated answer lost a previously verified fact. |
| history-followup-qualification.json | 54/54 | USD 0.076096435 | Snapshots comparison source qualified after follow-up guidance. |
| history-retrieval-full-qualification.json | 54/54 | USD 0.068219460 | Retrieval qualified at the same comparison source. |
| history-default-final-qualification.json | 54/54 | USD 0.065191950 | Selected default source qualified before later upstream integration. |
| history-pr-final-qualification.json | 53/54 | USD 0.091159270 | Newer base/Pi 0.87.1: paraphrased recall at 1,000 messages abandoned a non-null older-page cursor. |
| history-pr-pagination-qualification.json | 11 passed, 43 not run | USD 0.013316460 | Safe source-audit stop: stable-prefix memory ordering was missing. |
| history-pr-restored-prefix-qualification.json | 53/54 | USD 0.093003835 | Model guessed continuation tokens, skipped segment 7 and requested an invalid cursor. |
| history-pr-opaque-cursor-qualification.json | 53/54 | USD 0.091085410 | Model stopped after segment 5 and claimed the next cursor was unavailable. |

The latest paid run loaded clean committed
`3dd01cea8924ce22816a9b93539672431986d6d7`. All 12 distant samples and all 27
repeated answers passed; one strict long-loop completion/component/approval test
failed. Its pre-Pi observer recorded a valid raw response with `nextCursor`.
Exact outgoing bodies were not retained, so neither raw presence nor the model's
claim proves serialization loss. Deterministic wire tests preserve the controls;
the live failure's cause remains unproven. New opt-in eval wire diagnostics retain
only bounded synthetic controls after serialization to investigate a future run.
They do not regrade this failure.

The latest run's 238 provider-priced calls had p50/p95 latency
10.124/30.259 seconds. Charges, model counts and known token buckets reconciled;
cleanup/background failures and outstanding reservations were zero. No owned
paid process or disposable database remains. Conservative continuation spend is
USD 1.523810590 of the authorized USD 5 cap, leaving USD 3.476189410. Storage and
metadata changes require no new inference; no further paid run is scheduled.

## Preparation and caching

The exact final-ledger step partition compares three-question 100-message histories workflows.
Each policy has three samples with uncontrolled cache state.

| Mean charge | Earlier current | Qualified retrieval | Qualified snapshots |
| --- | --- | --- | --- |
| First question | USD 0.000709967 | USD 0.000776870 | USD 0.000767467 |
| First follow-up | USD 0.000078030 | USD 0.000075998 | USD 0.000074690 |
| Second follow-up | USD 0.000072205 | USD 0.000070123 | USD 0.000075240 |
| LLM preparation | USD 0.000416500 | No compaction calls | No compaction calls |
| Complete workflow | USD 0.001276702 | USD 0.000922992 | USD 0.000917397 |

Current incurred two compaction calls per workflow. Retrieval made two
first-question lookups; snapshots used bounded originals without lookups. This
compares whole policies and does not isolate summary production or establish a
causal payback threshold. Avoid paid preparation when loaded originals already
fit; use measured reuse before introducing a preparation break-even rule.

A separate four-call direct cache probe measured two fresh prefixes and their
immediate replays. Each fresh call charged USD 0.000489550 with no cache read;
each replay charged USD 0.000043120 with 3,882 read tokens. Total charge was
USD 0.001065340. Replay latency varied, so no consistent latency benefit follows.
This was not a product workflow or live expiry test. Documented retention is an
advisory prediction, not guaranteed routing/reuse; cache expiry is covered by
fake-clock tests. Retention-none requests are advisory and do not prove provider
billing disabled. See the primary [OpenAI caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
and [OpenRouter caching guide](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

## Reproduction

The maintained pricing input is a dated public catalog snapshot, not current
pricing or a required vendor. Verify rates before authorizing any paid run. The
CLI accepts generic model connections and compatible local providers; API keys
stay in the caller's environment. Reports belong under ignored `test-report/`.
This command records the unchanged final fixture selection; a new invocation
requires its own explicitly authorized cumulative budget.

```sh
pnpm exec tsx packages/testkit/src/cli/evals.ts \
  --live --provider openrouter --model openai/gpt-6-luna \
  --api-key-env OPENROUTER_API_KEY \
  --context-window 1050000 --max-output-tokens 4096 \
  --suite history --strategy retrieval --trials 3 --timeout-ms 180000 \
  --pricing packages/testkit/src/evals/fixtures/pricing-openrouter-luna-2026-10-08.json \
  --spend-cap-usd AUTHORIZED_REMAINING_BUDGET \
  --output test-report/evals/history-qualification.json \
  --case history-1000-exact --case history-1000-paraphrase \
  --case history-1000-changed --case history-1000-absent \
  --case history-1000-constraint --case history-1000-linked-run \
  --case history-10000-exact --case history-10000-paraphrase \
  --case history-10000-changed --case history-10000-absent \
  --case history-10000-constraint --case history-10000-linked-run \
  --case history-1000-long-tool-loop --case history-10000-long-tool-loop \
  --case history-1000-balanced-clarification-v3 \
  --case history-100-repeated-recall-v2 \
  --case history-1000-repeated-recall-v2 \
  --case history-10000-repeated-recall-v2
```

Add `--wire-diagnostics` only for the synthetic history loops when model-facing
control evidence is needed. It forwards transport requests unchanged, restores
fetch after the workflow, and records no prompts, headers, URLs or raw identifiers.
