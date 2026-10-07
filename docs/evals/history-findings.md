# Long conversation eval evidence

The initial current-strategy baseline passed 4 of 6 checks with GPT-6 Luna through
OpenRouter. Exact public-label recall passed with 100 original messages and
failed with 1,000 and 10,000 messages when the prepared summary omitted the label.
The current launch decision passed at all three sizes because the prepared
summary retained it. These outcomes establish a measurable retrieval target;
they do not establish reliability across other tasks or repeated trials.

The six workflows reported USD 0.0043041 in provider-reported charges across eight
model calls. That includes USD 0.0004163 of background compaction in the two
100-message trials. The larger ordinary fixtures contain deterministic synthetic
prepared summaries; generating these fixtures incurred no inference. This is
explicit fixture preparation, not evidence about the cost of producing summaries
in a real chat. Backlog and failed-summary scenarios remain separate stress cases.

See `history-current-baseline.json` for the sanitized fixture version, strategy,
code fingerprint, pricing assumptions, token buckets, criteria, and synthetic
answers. The original baseline retained unknown first-response measurements where
a short reply did not produce a streamed event. The runner now falls back to the
final persisted bot-message timestamp for such replies.

The baseline uses stable guidance before changing context and excludes history
retrieval tools. Its short chat crosses the existing compaction trigger, so
compaction is awaited and included in the reported workflow cost. Cache writes
may be unknown on some calls; provider-reported charges are retained without
inventing missing token measurements. No cost savings claim follows from these
six baseline trials alone.


The saved current-strategy reports have separate purposes. The six-case initial
baseline establishes exact recall and correction outcomes. The expanded valid
subset excludes nine cases whose original setup omitted the intended clear,
workspace switch, or CRM connection; the separate corrected security report
performs those transitions. The repeated baseline repeats exact recall,
corrections, and absent facts three times. The bounded stress report covers a
rich tool chain and a completed linked background investigation. Invalid raw
runs stay outside published evidence and must not be pooled with corrected runs.

Fixture identifiers alone do not establish comparability. Early development
reused `history-v1-seed-73` while correcting wording, setup, and first-response
measurement. Compare case semantics, deterministic grading, model limits,
working diff hashes, and the explicitly stated chronology before pooling data.
Original repeated-recall grading checked only the final reply while charging the
entire three-turn workflow. Separate repeated-recall v2 cases require correct
initial recovery and every follow-up, including a 100-message case without a
prepared summary so actual summary creation can be billed and observed. The
balanced ambiguity qualification case has its own v2 fixture version and
requires clarification between two equally represented projects; it does not
replace or reinterpret the original ambiguity outcomes.

The initial four-strategy matrix loaded code before the later stable history
search guidance, exclusive retrieval-call cost attribution, and background
failure/coverage reporting. Its total observed workflow charges remain useful;
its answer-versus-retrieval split and missing preparation diagnostics cannot be
interpreted as the latest implementation. Later qualification reports identify
their own loaded revision and diff hash. When retention capabilities are unknown,
cache-aware selection follows the same cold policy as snapshots; differences
between those matrix groups cannot be credited to cache prediction. Two trials
per case cannot establish population reliability.

The first matrix completed all 288 ordinary workflows and 16 original repeated
recall workflows, then stopped after six rich-loop workflows exposed structured
result corruption. Ten remaining workflows are explicitly not-run. The stop
occurred between workflows: the disposable database had no active runs and the
saved spend guard had no outstanding reservations. Its conservative accounted
charge was USD 0.42245413. Some failed rich-loop totals remain null because the
loaded runtime recorded an unmeasured synthetic stop event; those rows must not
be described as zero-cost calls or pooled into complete workflow cost estimates.

| Strategy | Ordinary checks passed | Ordinary reported charge |
| --- | --- | --- |
| Current | 50 / 72 | USD 0.053433365 |
| Retrieval | 58 / 72 | USD 0.04995585 |
| Snapshots | 63 / 72 | USD 0.082673135 |
| Cache-aware | 64 / 72 | USD 0.090047835 |

These are preliminary outcomes, not a default-selection decision. All observed
injection failures quoted and rejected the synthetic instruction; the forbidden
external-effect checks passed. All strategies failed the original ambiguity
wording check. Distant exact/paraphrase samples passed 0/8 for current, 2/8 for
retrieval, 7/8 for snapshots, and 8/8 for cache-aware. Unknown retention made the
last two selection policies equivalent, so their one-sample difference does not
establish a caching advantage. The later qualification uses repaired structured
results, stable search guidance, a balanced ambiguity fixture, per-turn recall
checks, and complete-workflow cost accounting.

The four-call prefix probe observed a fresh prefix, identical replay, changed
prefix, and changed replay. Fresh and changed prefixes each reported zero cached
input and USD 0.00048955; each immediate replay reported 3,882 cached input tokens
and USD 0.00004312. That is about 91.2% lower observed charge for these particular
replays. The four calls cost USD 0.00106534 altogether. First-response latency was
1,372 / 956 / 1,136 / 1,236 milliseconds, so this probe does not establish a
consistent latency improvement. Advisory predictions agreed with these four
observations, but routing and eviction remain uncontrolled.

The probe declares the documented 30-minute retention and 1,024-token minimum
from [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
and [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).
It does not request Pi's older short/long retention modes. Immediate replay is
live warm/cold evidence; it is not an expiry experiment. Fake-clock tests cover
expiry decisions, and live provider retention expiry remains unproven.

The later paired current/snapshots qualification stopped with 76 completed
workflows and 32 explicitly not-run. Among the 36 ordinary workflows per
strategy, snapshots passed 36/36 and current passed 18/36. Snapshots recovered
all 12 distant exact/paraphrase samples, matched current on all 18 correction,
durable-constraint, and absent-fact checks, and recovered all six linked outcomes
that current missed. These ordinary workflows reported USD 0.04405506 for
snapshots versus USD 0.02318717 for current, with 126 versus 41 model calls.
Median / 95th-percentile latency was 7,724 / 27,055 milliseconds for snapshots
and 4,114 / 9,573 milliseconds for current.

This does not qualify snapshots as the default. Both attempted snapshots rich
loops exhausted the 30-tool-call limit. The first current rich loop completed
12 diagnostic segments; its second hit the 180-second workflow deadline and a
cleanup failure. The requested graceful stop did not produce a clean workflow
drain: cleanup failure prevented further scheduling, and the owned process and
disposable database were subsequently verified stopped. The complete report's
cost remains unknown because an incurred cancelled call lacked final measured
usage; the conservative spend guard accounted for USD 0.2287896 with no
outstanding reservations. Balanced ambiguity and repeated-recall v2 workflows
were not reached. The production default remains current.

These paired trials loaded code before the later structured 12,000-character
tool-result ceiling. Offline product/runtime tests proved that the earlier
rich-loop result retained valid JSON and advanced cursors, but its roughly
25-kilobyte body left room for only one prior result in the context policy.
The newer ceiling preserves structured control fields and retains more prior
progress. The live failure alone does not establish that insufficient retained
progress caused the model's repeated calls; a separate bounded diagnostic tests
the revised policy. Reports preserve the original failures and loaded source
fingerprints rather than regrading or overwriting them.

The subsequent bounded rich-loop diagnostic loaded the structured tool-result
ceiling and attempted one snapshots workflow. It failed after 30 diagnostic
calls and 31 real model calls; the automatic failure stop left the second trial
not-run. The completed workflow took 73,249 milliseconds and reported USD
0.017315215, with no cleanup failure, background failure, or outstanding spend
reservation. The disposable database and owned process were stopped.

The eval-only observer recorded valid object results and matching next cursors
through segment seven, followed by repeated restarts from the initial cursor.
The observed segment groups were 1–5, 1–7, 1–6, 1–4, 1–7, then 1. This observer
runs before Pi serializes results, so its 25,660-byte raw result measurement does
not measure the bounded outgoing provider context. Offline product tests prove
valid bounded JSON and cursor retention at that later boundary. The live trace
establishes repeated restarts, but does not establish their cause. The candidate
remains unqualified; no further paid qualification was scheduled automatically.
Across this continuation, conservative accounting reached USD 0.679988315 of the
shared USD 1 cap, leaving USD 0.320011685.

A separate diagnostic then loaded the policy that keeps compact structured
records of earlier active-loop steps. The model recovered the verified component
and pending approval without external writes, and observed every segment from
one through twelve. It nevertheless repeated reads: 23 diagnostic calls and 24
model calls took 67,644 milliseconds and reported USD 0.012530305. The existing
criterion requires exactly twelve diagnostic calls, so this remains a failed
qualification result rather than being retroactively regraded as success. The
second planned trial was automatically not-run. Teardown completed cleanly,
with no background failure or outstanding reservation. Conservative cumulative
continuation accounting is USD 0.69251862, leaving USD 0.30748138 of the shared
cap. Correct final recovery in this one sample does not qualify the candidate's
loop efficiency or establish reliability.

The next bounded diagnostic used the configured model's actual context window,
with bounded historical navigation and compact prior tool-result bodies. Both
1,000-message loop trials passed the unchanged criteria: each read segments
one through twelve exactly once, recovered the component, preserved pending
approval, and made no external writes. Each additionally sent one progress
message, for 13 total tools and 14 model calls. Latencies were 31,765 and 37,818
milliseconds; complete workflow charges were USD 0.004083465 and 0.00435605.
Both workflows and teardown completed cleanly. These two samples support
proceeding to qualification, not a default decision or a reliability claim.
Their USD 0.008439515 charge brought continuation accounting to USD 0.700958135,
leaving USD 0.299041865 for the authorized remaining comparison.

The first complete snapshots qualification then finished all 54 workflows:
50 passed and four failed the original strict criteria. All twelve distant
exact/paraphrase samples, six corrections, six durable constraints, six linked
outcomes, six rich loops, and nine repeated-recall v2 workflows passed. One
absent-fact reply denied that a password had been discussed but volunteered a
related known calibration label; the strict exclusion failed. All three balanced
ambiguity v2 replies listed both project labels rather than clarifying the
project before supplying candidate answers. These failures were not waived,
and snapshots remained unqualified.

That complete qualification cost USD 0.097921115 across 289 model calls, with
median / 95th-percentile latency of 10,232 / 38,092 milliseconds. Its 36 ordinary
workflows passed 35/36 and cost USD 0.046035505 across 139 calls; six rich loops
cost USD 0.027270135 across 81 calls; nine three-turn recall workflows cost USD
0.019986945 across 58 calls. Every workflow and teardown completed, with no
background failure or outstanding reservation. Including the additional current
v2 baseline, conservative continuation accounting reached USD 0.80972295,
leaving USD 0.19027705.

The additional current v2 baseline passed 5/12: two of three balanced ambiguity
checks and all three 100-message recall workflows, while all six longer recall
workflows failed. Its complete charge was USD 0.0108437 across 36 model calls.
The 100-message workflows each performed real paid compaction, with charges of
USD 0.0004635 / 0.000454 / 0.000456; their complete three-turn charges were USD
0.001327185 / 0.00130954 / 0.00131075. The existing combined setup bucket does
not identify each question's charge, so these original reports cannot establish
an exact first-question/follow-up payback. New final-ledger step attribution
separates numbered foreground steps and workflow compaction without changing
question timing. A distinct clarification v3 fixture also permits a legitimate
pending `ask_user` choice; original v2 reports and grades remain preserved.

The focused concise-answer/clarification pilot passed all nine samples: six
strict absent-fact checks and three genuine pending project choices. It cost
USD 0.009844045 across 27 model calls. A matched-source final run then completed
all 54 snapshots workflows with numbered ledger attribution: 52 passed and two
paraphrase recoveries failed. All 42 non-distant checks passed, including the
stronger clarification v3 fixture and every repeated-recall turn. Distant
recovery passed 10/12, so the candidate still failed the preregistered gate.
One failure ignored an available older-result cursor; the other repeatedly used
multiword queries without falling back to the project name alone. The loaded
instructions contained conflicting phrase-versus-single-word search guidance.
These reports preserve the failures; repairing that wording requires fresh
measurements rather than regrading them.

The matched final snapshots run reported USD 0.09711853 across 292 model calls,
with median / 95th-percentile latency of 11,315 / 37,932 milliseconds. Every
foreground/background partition reconciled measured charges and model counts;
known token buckets also reconciled while unavailable buckets remained unknown.
There were no unattributed calls, cleanup failures, or queue failures. Its
ordinary 36 checks passed 34/36 and cost USD 0.04608985 across 139 calls. The
unchanged earlier current ordinary baseline passed 18/36 for USD 0.02318717
across 41 calls. Better recovery had a higher observed workflow cost; it must
not be marketed as an overall cost reduction. Provider reuse was observed,
but retention was unknown and cache state was uncontrolled.

The final matched-source 100-message measurements separate each foreground
question from actual workflow preparation. All three questions passed in every
trial for both policies. Values below are means across three complete workflows.

| Measured charge | Current | Earlier snapshots | Adaptive originals |
| --- | --- | --- | --- |
| First question | USD 0.000709967 | USD 0.001293803 | USD 0.000760967 |
| First follow-up | USD 0.000078030 | USD 0.000614353 | USD 0.000079450 |
| Second follow-up | USD 0.000072205 | USD 0.000619073 | USD 0.000077958 |
| Workflow LLM preparation | USD 0.000416500 | No compaction calls | No compaction calls |
| Complete three-question workflow | USD 0.001276702 | USD 0.002527230 | USD 0.000918375 |

The adaptive column comes from the subsequent source revision and uses the same
seeded three-question scenario. Each column has three workflows; provider cache
state was uncontrolled. These are observed policy costs, not a randomized estimate
of the savings caused by any single change.

Current incurred two actual compaction calls per workflow; snapshots incurred
none. Current was about 49.5% cheaper overall in this particular short-chat
scenario, including preparation. This compares whole policies, not an isolated
summary-preparation intervention, and cannot establish a causal payback period
or justify paid preparation in every chat. No general break-even rule was
inferred. The exact per-question ledger partition provides evidence for a later
controlled decision, while deterministic navigation itself requires no LLM
preparation. The larger current recall workflows still missed the distant facts.
Conservative continuation accounting after the final run reached USD 0.92266628,
leaving USD 0.07733372 of the shared cap.

The next instruction repair removed the conflicting suggestion to search a
project phrase: start with the project name alone, and retain an unexhausted
broader search cursor after empty narrower queries. All twelve fresh distant
exact/paraphrase samples then passed. The targeted run cost USD 0.01285668
across 46 calls. Observed paraphrase traces followed the older-result cursor,
including after a narrower query returned no matches. This establishes the
latest targeted gate result; it does not replace a full matrix at that source.

A separate adaptive short-history run retained bounded loaded originals instead
of forcing a navigation catalog and lookup. All three 100-message workflows
passed every question, with zero tools, zero compaction, and exactly three model
calls per workflow. No prepared summary was seeded or created. It cost USD
0.002755125 altogether, with mean whole-workflow charge USD 0.000918375. The
mean first question / follow-ups were USD 0.000760967 / 0.000079450 /
0.000077958. This was about 28.1% less than the earlier current workflow including
paid preparation, and 63.7% less than the earlier forced-snapshots workflow.

These are three samples per policy with uncontrolled provider cache state, not
an isolated preparation experiment. They support avoiding unnecessary summary
or lookup work when originals already fit the bounded allowance; they do not
establish a causal payback threshold or broad model reliability. Both new runs
loaded the same implementation fingerprint, reconciled all step/background
charges and model counts, completed cleanup, and left no outstanding reservation
or owned disposable database. Conservative continuation accounting is USD
0.938278085, with USD 0.061721915 remaining. A fresh matched-source full54 matrix
is still pending; no production default change or additional paid run is implied
by these targeted results.

The subsequent matched-source full matrix completed all 54 workflows on the
same keyword/adaptive implementation fingerprint as the targeted checks.
It passed 53 and failed one repeated-1000 workflow: the first two answers
correctly identified the label, but the third declined to verify it. Its two
third-turn searches left a non-null older-page cursor unused. This was not a
tool-limit, cleanup or background failure. Exact outgoing prompts were not
retained; recent-history construction supports availability of the earlier
assistant replies, but does not provide direct wire evidence for that trial.
The strict repeated-question retention gate remains failed; the candidate is
not qualified and the default remains unchanged.

All 36 ordinary workflows, twelve distant exact/paraphrase samples, six strict
12-read tool workflows and three v3 clarification workflows passed. Eight of
nine repeated workflows passed every answer. The full run cost USD 0.076252385
across 255 model calls, with workflow p50 / p95 latency 9.660 / 36.442 seconds.
All ledger partitions reconciled costs, calls and known token buckets; no
background or cleanup failures or outstanding reservations remained.

The fresh 100-message group passed all nine answers without compaction. Two
workflows used no lookup tools; the third used two first-question lookups.
Mean first question / follow-ups were USD 0.000845817 / 0.000080812 /
0.000073795, and the complete-workflow mean was USD 0.001000423. That is about
21.6% less than the earlier current workflow including paid preparation and
60.4% less than the earlier forced-snapshots workflow. These three-sample policy
comparisons have uncontrolled provider cache state; they do not isolate the
cause of savings or establish a paid-preparation break-even threshold.

The cumulative cap was explicitly raised to USD 5 before this full run.
Conservative accounted spend is now USD 1.01453047, leaving USD 3.98546953.
The original negative reports and this full-matrix failure remain preserved.
No further paid run follows automatically from this report.

The next generic guidance first checks visible conversation, permits reuse of
previously source-verified facts unless a later correction contradicts them,
and requires following an unexhausted broader cursor before declaring a fact
unavailable. The subsequent matched-source snapshots run passed all 54 unchanged
workflow grades, including all 27 repeated-question answers. The preceding
53/54 result remains failed in its original report.

This run cost USD 0.076096435 across 248 provider-priced model calls. Workflow
p50 / p95 latency was 9.633 / 36.840 seconds. All costs, call counts and known
token buckets reconciled, with zero background or cleanup failures and no
outstanding reservation. The three short100 workflows each used exactly three
model calls, zero tools and no compaction; mean first / follow-up1 / follow-up2 /
complete charges were USD 0.000767467 / 0.000074690 / 0.000075240 / 0.000917397.
These remain three-sample whole-policy observations with uncontrolled cache
state, rather than causal preparation or cache-benefit estimates.

Conservative cumulative spend is USD 1.090626905 of the authorized USD 5 cap,
leaving USD 3.909373095. Snapshots now passes this sampled quality gate; choosing
the least-cost qualifying default still requires assessing the latest-source
retrieval candidate. Unknown-capability cache-aware selection is deterministically
equivalent to snapshots and receives no separate quality or caching credit.

The latest-source retrieval diagnostic passed all twelve distant samples for
USD 0.0112073 across 43 calls. A subsequent complete retrieval matrix then
passed all 54 unchanged workflow grades, including all 27 repeated answers.
It loaded the identical implementation fingerprint, case versions and graders
as the successful snapshots matrix.

| Complete qualification | Retrieval | Snapshots |
| --- | --- | --- |
| Passed workflows | 54 / 54 | 54 / 54 |
| Full measured charge | USD 0.068219460 | USD 0.076096435 |
| Model calls | 246 | 248 |
| Workflow p50 | 9.273 seconds | 9.633 seconds |
| Workflow p95 | 38.978 seconds | 36.840 seconds |
| Ordinary36 charge | USD 0.030151330 | USD 0.036254290 |
| Rich-loop6 charge | USD 0.023983145 | USD 0.025025865 |
| Clarification3 charge | USD 0.001781775 | USD 0.002247900 |
| Repeated9 charge | USD 0.012303210 | USD 0.012568380 |

Retrieval is the observed lowest-full-cost qualifying distinct policy, about
10.4% lower charge here, with slightly higher p95 latency. It also avoids
building navigation snapshots. These were sequential runs with uncontrolled
provider cache state, not a randomized causal savings experiment; three trials
per scenario remain limited reliability evidence.

For short100 specifically, retrieval made two first-question lookups in each
workflow, then answered both follow-ups without tools. Snapshots used zero tools.
Neither policy compacted. Retrieval mean first / follow-up1 / follow-up2 /
complete charges were USD 0.000776870 / 0.000075998 / 0.000070123 / 0.000922992,
slightly above snapshots' complete mean USD 0.000917397. Selection uses complete
workflow cost across qualifying scenarios rather than one favorable subgroup.

Both full runs reconciled foreground/background charges, call counts and known
tokens, with no cleanup or background failures. The latest conservative total
is USD 1.170053665 of the authorized USD 5, leaving USD 3.829946335. Retrieval was selected for the shared default from this comparison. Its wiring
and final-source qualification are still pending; no further paid run is implied
by this report.

After shared default/fallback wiring and persisted compaction suppression were
settled, the final-source retrieval matrix passed all 54 unchanged workflow
grades: all twelve distant samples, all six exact12-read loops, all three v3
clarifications and all 27 repeated-question answers. The final loaded source
fingerprint differs from the earlier matched comparison and is recorded in
`history-default-final-qualification.json`. Documentation updates after launch
do not change its loaded executable source.

The final run cost USD 0.065191950 across 227 provider-priced calls. Workflow
p50 / p95 was 8.661 / 32.224 seconds. Ordinary36 / loop6 / clarification3 /
repeated9 charges were USD 0.029096985 / 0.023875175 / 0.001797650 /
0.010422140. All foreground/background charges, model counts and known token
buckets reconciled; no background or cleanup failure or outstanding reservation
remained. Every short100 workflow made two first-question lookups and no
compaction. Mean first / follow-up1 / follow-up2 / complete charges were USD
0.000768277 / 0.000075348 / 0.000069640 / 0.000913265.

This verifies the finished selected default against the preregistered sampled
gates. It does not convert sequential, uncontrolled-cache cost comparisons into
causal evidence or establish general model reliability from three samples per
scenario. All original negative outcomes remain preserved. Final conservative
continuation spend is USD 1.235245615 of the authorized USD 5, leaving USD
3.764754385. All owned paid processes and disposable databases are cleaned up;
no further paid evaluation is scheduled.

To reproduce the final fixture selection, extract its public pricing metadata
into an ignored report directory, supply a generic OpenRouter connection key
through the named environment variable, and invoke the following command.
A reproduction incurs new model charges and requires its own authorized budget;
this command records the original final invocation's remaining cap.

```sh
mkdir -p test-report/evals
python3 -c 'import json; d=json.load(open("docs/evals/history-default-final-qualification.json")); json.dump(d["pricing"],open("test-report/evals/final-pricing.json","w"))'
pnpm exec tsx packages/testkit/src/cli/evals.ts \
  --live --provider openrouter --model openai/gpt-6-luna \
  --api-key-env OPENROUTER_API_KEY \
  --context-window 1050000 --max-output-tokens 4096 \
  --suite history --strategy retrieval --trials 3 --timeout-ms 180000 \
  --pricing test-report/evals/final-pricing.json \
  --spend-cap-usd 3.829946335 \
  --output test-report/evals/history-default-final-qualification.json \
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

The report records all eighteen selected case versions: ordinary and loop cases
use `history-v1-seed-73`, all-turn repeated scenarios use
`history-repeated-all-turns-v2-seed-73`, and balanced clarification uses
`history-balanced-clarification-v3-seed-73`. Earlier reports with the reused
history-v1 label must also be distinguished by source fingerprint and documented
fixture chronology. Final default selection proceeded from same-source full
retrieval/snapshots comparison, shared retrieval wiring and fallback verification,
then this changed-final-source complete matrix with unchanged graders.

The PR integration moved onto a newer main base and Pi0.87.1, with the generic
connection output limit expressed through canonical `maxTokens`. The unchanged
54-workflow qualification at that frozen source passed53 and failed one
paraphrase1k sample. All27 repeated answers and six strict12-read loops passed.
The failed sample searched Aurora (five matches, older cursor8), then extraction,
Aurora identifier, Aurora data and identifier (each zero matches). It declined to
verify the fact without consuming the unfinished Aurora page. Coverage of that
query's older originals remains unverified; the failure is retained without waiver.

The run charged USD0.091159270 across242 provider-priced calls, with workflow
p50/p95 9.971/35.225seconds. All foreground/background charges, call counts and
known tokens reconciled. Cleanup and background failures were zero, reservations
cleared, and the owned disposable database was removed. Conservative cumulative
spend is USD1.326404885 of5, leaving USD3.673595115.

The report retains the actual loaded base revision and a separately labelled
frozen source-only fingerprint. Its original CLI workingDiffHash is null because
the default child-process buffer overflowed on the large tracked report diff;
a metadata-only correction made afterward does not relabel the observed run.
The latest-base qualification gate remains failed pending a source correction
and separately authorized verification. Earlier passing and failing reports remain
unchanged.

The subsequent pagination-source run was stopped for a source-audit finding,
not an observed evaluation failure: the integrated executor had lost the
original volatile-memory ordering correction. A graceful signal finished its
in-flight workflow, then stopped new scheduling. Eleven workflows passed and
43 remain explicitly not run; this partial matrix makes no qualification claim.
The loaded committed revision and clean source fingerprint are retained in
`history-pr-pagination-qualification.json`.

Its31 provider-priced calls cost USD0.013316460. All step partitions reconciled,
cleanup/background failures were zero, reservations cleared and the owned
synthetic database was removed. Conservative cumulative spend is now
USD1.339721345 of5, leaving USD3.660278655. The prior53/54 failure remains failed;
a corrected-source full matrix is still required.
