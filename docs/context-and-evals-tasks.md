# Conversation context and model eval tasks

Generated JSON reports are preserved locally under ignored `test-report/evals/archive/`, with a second backup outside the disposable worktree. They are not tracked documentation or repository downloads; maintained findings and synthetic fixtures remain in source control. Report references below identify local archived evidence, including every original failed and partial run.

Make long conversations reliable without sending their entire history on every
model call. Give bots access to original messages and linked background work,
select a bounded active context, and measure the full cost and performance of
each strategy before choosing defaults.

This file records the completed implementation goal, verified tasks, and measured
limitations. Historical progress notes preserve failed experiments and earlier
completion gates. The initial completion record below predates integration with
the current main branch; the PR verification record distinguishes that later work.

## Initial implementation completion record

The initial implementation and local verification gates were completed. Retrieval is the shared
production default, with bounded standalone fallback when history tools are absent.
Existing reports include failed trials and must remain intact. After the follow-up
guidance fix, the snapshots candidate passed all 54 workflows. The simpler recent
history and retrieval candidate passed all 54 workflows on the same candidate
source, with lower observed complete workflow cost. Sequential run order and
uncontrolled provider cache prevent a causal savings claim. The final default and
fallback source subsequently passed all 54 workflows, all 27 repeated answers,
all twelve distant samples, and all six strict twelve-read loops. Its charge was
USD 0.06519195 across 227 model calls, with median/p95 latency 8.661/32.224 seconds.
The final report is `test-report/evals/archive/history-default-final-qualification.json`.

Completed delivery steps:

- [x] Audit the current working tree and the evidence below. Recheck recently
      changed code before treating older broad test results as final verification.
      Current-source focused and broad checks passed; both new reports share a
      source fingerprint, reconcile their totals, and have zero reservations.
- [x] Resolve the failing group-history product fixtures. Their intended large
      paging model now declares a 160,000-token window and 4,096-token output
      reserve. All 66 serialized checks pass, including small-window safeguards.
- [x] Verify the corrected history guidance on actual outgoing requests: begin
      with one project or topic keyword and follow the broader query's cursor
      when narrower queries are empty. System and tool instructions must agree.
- [x] Verify the adaptive short-history policy: keep original loaded history
      when its wire-equivalent conservative estimate fits the smaller of 16,384
      tokens and one quarter of the available model input budget. Otherwise use
      the bounded recent history and navigation catalog. The overall model budget,
      output reserve, required current input, and valid tool pairs still apply.
      Small chats must not acquire unnecessary search calls or paid preparation.
- [x] Run an identified targeted distant-recall diagnostic after the offline
      fixes. All twelve samples passed: four exact/paraphrase cases with three
      trials each. Known charge was USD 0.01285668 across 46 model calls; teardown
      completed with no outstanding reservations. This does not replace full
      final-source qualification.
- [x] Obtain explicit authorization for any increase to the cumulative live cap
      before spending beyond it. The user authorized a cumulative USD 5 cap.
      Carry all earlier spend forward. After the full adaptive qualification the
      guard has charged USD 1.235245615, leaving USD 3.764754385 after initial final
      verification. PR integration reuses this remaining allowance for one full
      qualification against the updated SDK; it does not reset the cumulative cap.
      An uncertain earlier call is conservatively
      included. These are guard estimates, not billing guarantees.
- [x] Run the full 54-workflow qualification against the corrected candidate source
      once funding permits. Older passing samples plus a new targeted subset do
      not substitute for a full final-source run. Pass every distant exact and
      paraphrase sample and all continuity, absence, clarification, and rich-loop
      gates. Preserve unchanged graders and earlier failures.
      The 53/54 run remains preserved. The corrected-guide snapshots run passed
      all 54, including all 27 repeated answers. The same-source retrieval run also
      passed all 54 and all 27 repeated answers. Final default wiring and its
      final-source verification remain separate delivery gates.
- [x] Fix the audited token-total and applicable-tier pricing gaps. Omitted cache
      buckets must not become a trustworthy SDK-synthesized total that releases
      reservations; observed one-hour writes require pricing in the applicable
      context tier. Verify both through deterministic protocol and budget tests.
      The pinned Anthropic endpoint and pricing regressions pass, alongside 60
      focused accounting/cache/transport/budget checks and package type checks.
- [x] Measure first question, each follow-up, preparation, and complete workflow
      costs for the final adaptive policy. Reconcile these with the durable ledger.
      Do not claim that free assembly makes the entire workflow cheaper without
      measuring the extra retrieval and answer calls it causes.
      All three adaptive 100-message workflows passed every turn with three model
      calls and zero tools or compaction. The mean complete charge was
      USD 0.000918375. Full final-source quality qualification remains outstanding.
- [x] Choose and wire one shared production default only after qualification.
      Keep explicit baseline selection available for evals. Direct runtime users
      without history tools need a bounded fallback that does not discard old
      facts while implying that retrieval remains available. Verify actual default
      provider requests and background compaction behavior.
      Retrieval is shared by executor, main Pi, and child Pi. Undefined and explicit
      retrieval emit identical provider messages and tools with a history backend.
      Standalone fallback preserves 40 fitting originals and enforces a small
      model budget. Actual default product tests verify scoped reads, all twelve
      loop steps, repeated source-verified answers, and no new or queued compaction.
- [x] Run final unit, type, lint, protocol, and PostgreSQL integration checks after
      the last implementation change. Preserve unrelated changes and avoid local
      Electron E2E. Validate and sanitize the final reports.
      Final checks pass: 372 unit suites / 3,821 tests, 19 package type checks,
      mobile TypeScript, lint (21 existing warnings), 140 focused checks including
      24 PostgreSQL checks, and 14 actual Pi checks. No local Electron E2E ran.
- [x] Qualify the selected policy on the final default/fallback source: all 54
      unchanged workflows with three trials per case and no failed or skipped gate.
      This final paid run carries cumulative spend forward rather than starting
      a new USD 5 allowance.
      All 54 passed on the final source, with reconciled step/background costs,
      calls and known tokens; zero cleanup/background failures or reservations.
- [x] Publish findings, defaults, reproducible commands, cost and latency tradeoffs,
      sample uncertainty, and limitations. Update this checklist with final proof.
      Reports and findings are sanitized and reproducible. Synthetic databases
      were removed and unrelated changes preserved. This initial record preceded
      the subsequently authorized PR and merge work.

## PR integration verification

Integration against the current main branch uses Pi 0.87.1 and its transcript
system messages, preserves upstream authentication and streaming safeguards, and
uses the existing generic `maxTokens` setting rather than a second output limit.
History selection preserves system instructions, section patches, tool deltas,
current requests, and valid tool exchanges. Cache identity includes the transcript
system fields. Unknown models need declared context metadata when the complete
required prompt cannot fit the conservative fallback budget; instructions and
tools must never be silently dropped to fit it.

The PostgreSQL integration harness now includes all new history and usage suites;
all 29 serialized suites pass.
Usage migrations extend existing cache columns rather than adding duplicates.
Production builds, all 19 package type checks, mobile TypeScript, lint, and 44
context/transcript regressions pass. The broad current-base unit run passes 527
suites / 6,410 tests, with three failures in unchanged Linux launcher mock tests
on macOS and 224 opt-in tests skipped. A narrow rerun against unchanged base
files reproduces the supervisor launcher failure; Linux CI remains a merge gate.
The first current-base qualification completed 54 workflows with unchanged
three-trial graders: 53 passed. A paraphrase recall trial stopped after empty
narrower searches while the original broader search still had unread pages.
All 27 repeated answers and all six strict twelve-read loops passed. Charge was
USD 0.09115927 across 242 model calls, with median/p95 latency 9.971/35.225 seconds.
Accounting reconciled; background and cleanup failures and reservations were zero.
The failed qualification is preserved in
`test-report/evals/archive/history-pr-final-qualification.json`; it does not satisfy the final
gate. Its source fingerprint is separately method-labelled because the original
CLI diff capture exceeded its buffer.

The cumulative guard charge is USD 1.326404885, leaving USD 3.673595115 under the
same authorized USD 5 cap. The pagination correction makes coverage query-specific
and carries the original query and filters in ready-to-call continuation arguments.
Offline verification passes: 29 fresh serialized PostgreSQL suites / 182 tests,
168 focused date and retrieval checks, 104 model-limit checks, 41 accounting and
fingerprint checks, three web settings E2E cases, three Docker replay cases, package
and mobile type checks, and lint. Main-branch reconciliation preserves current
mobile behavior.

The first pagination requalification was stopped gracefully after an audit found
that reconciliation had moved memory ahead of stable instructions. Its partial
report, `test-report/evals/archive/history-pr-pagination-qualification.json`, preserves eleven
passing workflows and 43 not run, charged USD 0.01331646 across 31 calls, and zero
background/cleanup failures or reservations. The cumulative charge is now
USD 1.339721345, leaving USD 3.660278655; no allowance was reset.

The original cache ordering is restored. An actual Pi provider regression now
assembles instructions through the executor helper rather than hand-writing the
expected order: changing group, messaging, memory, and scratchpad context preserves
the complete stable instruction prefix and tool schemas. All 109 focused checks
pass. The restored-prefix full run completed all 54 workflows: 53 passed. All twelve
distant recall trials and all 27 repeated answers passed, but one strict tool loop
skipped a segment by inventing a cursor rather than copying the returned value.
The unchanged grader correctly rejected eleven successful reads plus one invalid
request. Its report, `test-report/evals/archive/history-pr-restored-prefix-qualification.json`,
preserves the failure and reconciles USD 0.093003835 across 248 model calls, with
zero background/cleanup failures and reservations. The cumulative guard charge
is USD 1.43272518, leaving USD 3.56727482 under the original USD 5 cap.

A provider-neutral instruction now requires copying opaque pagination cursors
exactly and rechecking the last successful result after a rejected cursor. This
stable guidance precedes changing context. Existing actual Pi and twelve-page
product regressions cover the outgoing instructions and preserved continuation
values. The full unchanged qualification of this correction completed 54 workflows: 53
passed. All twelve distant-recall trials, all 27 repeated answers, and five of six
strict loops passed. One 1,000-message loop stopped after five reads, claiming its
shortened result lacked a continuation cursor. The raw result was valid JSON with
a cursor; the failed live outgoing payload was not captured, so this explanation
does not establish a serialization defect. Deterministic actual-wire regressions
preserve every cursor, but they do not waive the live failure.

`test-report/evals/archive/history-pr-opaque-cursor-qualification.json` preserves this result on
clean committed source `3dd01cea`. Its USD 0.09108541 charge across 238 model calls
reconciles, with no cleanup/background failures or outstanding reservations. The
cumulative guard charge is USD 1.52381059, leaving USD 3.47618941 under the same
USD 5 cap. No additional paid run is active. Final live qualification remains
failed and merge is held even if CI passes; further investigation needs evidence
from the failed model-facing payload before changing serialization or guidance.
Historical reports and failed trials remain unchanged.

The user has authorized live evaluation within the cumulative USD 5 cap. Before a
live run, resolve pricing and credentials through the existing generic connection;
ask for missing configuration only if it is actually unavailable. Never put
credentials or real production conversations into this file or eval fixtures.

## Product requirements

- Conversations can contain 10,000 messages. Original messages remain available
  through authorized retrieval even when omitted from the active prompt.
- A message is a natural anchor for an exchange and its background work. Retrieval
  must reveal clarifications, outcomes, artifacts, and later corrections when relevant.
- Recent exchanges can retain more detail. Older exchanges can use short original
  messages, existing completion messages, or reusable snapshots.
- Do not include all older snapshots in every prompt. Search and pagination must
  keep both prompts and tool responses bounded.
- Context selection must not require an LLM call. Cache expiry alone must never
  trigger paid compaction, summary generation, or cache keepalive requests.
- Prefer deterministic selection, bounded reads, and existing text under context
  pressure. Paid summarization is a fallback when these cannot preserve necessary
  task state, or when measured reuse savings justify its full cost.
  Reuse a summary until its covered content changes; do not regenerate it per turn.
- Rebuilding a prompt from stored material is local assembly, not a model call.
  Before adding paid preparation, compare its cost with the expected savings over
  actual follow-ups, including cache writes, cache reads, and retrieval overhead.
  Keep the simpler free policy when the expected reuse is unknown or insufficient.
- Age influences selection but does not invalidate durable constraints, decisions,
  unresolved work, or approvals. A cold cache does not mean the task has changed.
- Keep shared behavior in packages and orchestration on the backend. Web,
  Electron, and mobile must benefit from the same context and retrieval behavior.
- Keep providers optional. Local history search and context selection must work
  without an external memory service, embeddings, or hosted search vendor.
- Preserve authorization, channel isolation, deletion semantics, secret redaction,
  cancellation, steering, and action approval behavior.

## Original baseline to reproduce

The executor loads up to 200 recent messages. Background compaction is normally
queued after 100 uncompacted messages and incorporates up to 50 oldest messages
into a replacement rolling summary. A valid local summary is combined with the
subsequent loaded messages. Invalid coverage falls back to the recent window.
Summaries are capped at 20,000 characters and new transcripts at 40,000 characters.
Compaction currently uses counts and character caps rather than a model context budget.

Before the partial work, the Pi runtime exposed cache read and write usage,
reasoning usage, total tokens, and estimated cost. Rakazo forwarded and persisted
only input and output counts. The eval runner measured tokens, tool calls, and
latency but always reported cost as null. General text and tool-result compaction
within a running agent loop was not implemented; screenshot context had separate
pruning. Recheck these
statements against the audited revision before describing them as current behavior.

Pi provides context transformation and next-turn hooks. First implement behavior
through these boundaries. Change or patch Pi only if a deterministic reproducer
demonstrates a missing capability; do not replace the runtime speculatively.

Relevant implementation locations:

- `packages/adapters/src/executor.ts`
- `packages/adapters/src/history-compaction.ts`
- `packages/adapters/src/pi-runtime.ts`
- `packages/adapter-kit/src/types.ts`
- `packages/db/src/messages.ts` and `packages/db/prisma/schema.prisma`
- `apps/api/src/search.ts`
- `packages/testkit/src/evals/` and `packages/testkit/src/cli/evals.ts`
- `docs/agent-verification.md`

## Tasks

### 0 Audit the starting point

- [x] Inventory the existing changes and separate this work from unrelated edits.
      Do not reset, overwrite, or commit unrelated work.
- [x] Review existing accounting, retrieval, context helpers, eval fixtures, and
      reports against this checklist. Reuse verified work and record missing wiring.
- [x] Confirm that context enforcement actually runs before every main and subagent
      provider call. A tested helper alone does not complete runtime integration.
- [x] Identify which baseline reports remain valid, including fixture preparation,
      compaction coverage, code revision, and failures caused by the harness. Never
      silently compare results from different fixture semantics.
- [x] Run the focused offline checks needed to establish a trustworthy starting
      point. Do not start paid comparisons until usage accounting and budget guards pass.

Acceptance: the goal begins with an explicit verified inventory, remaining work,
and reproducible baseline rather than repeating or assuming earlier progress.

### 1 Preserve complete usage accounting

- [x] Define provider-neutral usage fields with documented semantics and optional
      or nullable measurements for uncached input, cache reads, cache writes, output,
      reasoning, total tokens, and cost provenance.
- [x] Audit the installed Pi provider mappings. Pi input excludes cache buckets;
      reasoning is a subset of output. Normalize without counting either twice.
      Distinguish omitted upstream usage from genuine reported zero usage.
- [x] Forward usage from normal model calls and subagents. Retain reported usage
      from failures, retries, interrupted runs, and background summarization.
- [x] Persist call attribution and operation kind so compaction and subagent
      costs can be separated while remaining part of the total workflow cost.
      Do not fabricate a foreground run relation for a background job.
- [x] Add the necessary migration and update shared contracts and consumers.
      Preserve compatibility for runtimes that cannot supply these measurements.
- [x] Ensure idempotent accounting does not duplicate the same reported usage
      event. Usage already incurred must survive clearing or deleting chat content.
- [x] Verify through deterministic model endpoint fixtures and persisted records.

Acceptance: fixtures with known cache and reasoning breakdowns produce exact
totals through the real Pi and executor boundary. Unsupported measurements remain
unknown. No real inference is required for these checks.

### 2 Make eval measurement trustworthy

- [x] Extend trial and aggregate reports with the complete usage breakdown,
      model calls, time to first response, total latency, and estimated dollar cost.
      Define whether first response means first streamed text or first visible output.
- [x] Record model, connection type, strategy, fixture version, code revision,
      pricing source, and pricing version without exposing account identifiers or credentials.
- [x] Treat Pi catalog costs as estimates. Do not interpret compatible models'
      zero price placeholders as free inference. Support explicit pricing metadata
      through generic configuration; leave unavailable prices unknown.
- [x] Report answer, setup, retrieval, subagent, and compaction costs separately
      and together. Avoid measuring only the final answer while hiding preparation costs.
- [x] Capture background work deterministically and await relevant jobs before
      finalizing trial accounting. Preserve totals across history clearing and failures.
- [x] Define cache hit rate using cache-eligible input and documented token buckets;
      keep unknown or inapplicable rates null.
- [x] Add a spend cap for live runs, defaulting to USD 5 unless explicitly overridden.
      Estimate the next call conservatively, reserve for concurrent work, and stop
      scheduling when the remaining budget is insufficient. Record that this is a
      guard rather than a provider billing guarantee. Unknown pricing blocks live
      spending until pricing is supplied; listing and offline tests still work.
- [x] Validate report arithmetic, attribution, unknown values, budget handling,
      and cleanup with offline tests. Update `docs/agent-verification.md`.

Acceptance: known fixtures produce exact accounting and missing credentials or
prices produce an explicit not-run result. Trial cleanup leaves no continuing
jobs that can spend after the report is finalized.

### 3 Establish long conversation baselines

- [x] Build compact, seeded generators for 100, 1,000, and 10,000-message chats.
      Seed history directly rather than paying a model to generate filler exchanges.
- [x] Cover exact facts, paraphrased topics, date references, changed decisions,
      unresolved background work, ambiguous matches, absent facts, and distant constraints.
- [x] Include oversized messages, rich tool results, multiple compaction cycles,
      compaction backlog, failed summaries, and long tool loops.
- [x] Grade answers against synthetic source facts and persisted effects. Test
      that a rejected proposal or obsolete preference is not treated as current.
- [x] Add isolation and injection scenarios: inaccessible chats, private channel
      history, cleared content, and historical text that attempts to issue instructions.
- [x] Run and retain the current strategy baseline before changing history selection.
      The existing prompt-order change is part of this baseline; identify it explicitly.

Acceptance: repeatable fixtures and deterministic criteria distinguish agent,
product, provider, harness, and incomplete failures. Each baseline reports quality,
full workflow usage, cost, and latency.

### 4 Add original history retrieval

- [x] Add shared `search_history` and `read_history` tool contracts and backend handlers.
      Search defaults to the current chat, supports date filters and pagination, and
      returns bounded excerpts, timestamps, and stable message references.
- [x] Start with local full-text search using existing primitives where suitable.
      Verify indexing and query performance at 10,000 messages. Keep future semantic
      search behind an optional provider interface.
- [x] Read bounded context before and after a message, with pagination rather than
      unbounded transcript dumps. Expose enough linkage to inspect the request,
      clarification, response, associated run, and authorized artifacts.
      Oversized individual messages also need within-message pagination so omitted
      details remain reachable instead of permanently truncating the original.
- [x] Validate access on every read and search. A model-supplied message or run ID
      is not authorization. Preserve group and messaging channel visibility rules.
- [x] Apply secret redaction and untrusted-data boundaries to excerpts and run detail.
      Cleared or deleted history and derived search records must become inaccessible.
- [x] Provide concise guidance for searching old discussions and checking surrounding
      messages before claiming an exact recollection.

Acceptance: the bot finds relevant original exchanges in a 10,000-message chat,
checks subsequent corrections, and does not invent facts or access forbidden history.

### 5 Explore message snapshots and linked background work

- [x] Define a snapshot as a navigation aid anchored to original message IDs and
      covered sequence ranges, with timestamps, topic, outcome, and open-work references.
      A multi-message exchange may need one snapshot rather than one per message.
- [x] Reuse short originals and existing completion messages first. Derive links
      and status from persisted product state without asking an LLM to restate them.
- [x] Generate additional summaries only for large exchanges or runs when justified.
      Persist coverage and version information so results are reusable and stale
      content can be invalidated after edits, clearing, or relevant updates.
      It is acceptable to ship without generated snapshots if deterministic snapshots
      satisfy the quality gates; explain that decision with evidence.
- [x] Avoid making snapshots the source of truth for approvals or exact facts.
      Retrieve original evidence and current authoritative action state when necessary.
- [x] Index and page snapshots; never send the full snapshot catalog every turn.
- [x] Add this as an eval strategy rather than assuming it improves on rolling summaries.

Acceptance: a short old message can lead to its larger background investigation
and final outcome. Existing short material requires no additional inference.
Eval reports include the creation and maintenance cost of generated snapshots.

### 6 Introduce bounded context selection

- [x] Define one shared context policy and a model-aware budget covering instructions,
      tools, current input, images, retrieved history, agent-loop results, and output reserve.
      Use available token counts or conservative estimates; document uncertainty.
- [x] Select current work, recent complete exchanges, durable constraints, and relevant
      older context within that budget. Use age as one signal, not a deletion rule.
- [x] Keep selection deterministic and free of inference. Assemble existing snapshots,
      original messages, summaries, and authoritative task state without rewriting them.
- [x] Integrate budget enforcement before the first call and subsequent tool-loop calls
      through Pi hooks, preserving valid tool-call/result pairs, steering, and cancellation.
- [x] Handle oversized individual messages and compaction backlog without stalling
      a cursor or silently assuming unavailable history has been summarized.
- [x] Trigger paid compaction only when needed to proceed within the budget or when
      measured amortized savings justify it. Reuse stored results; account for each call.
- [x] Preserve existing clear-generation and compare-and-set safeguards. Retrieval
      remains available for facts omitted from active context.

Acceptance: small-context models and long tool loops remain within their budget,
retain active constraints, and can retrieve omitted details. A pause or expired
cache causes zero automatic summarization calls by itself.

### 7 Make context selection aware of cache behavior

- [x] Move changing memory, scratchpad, and chat context after stable system guidance.
      Implemented and verified in outgoing provider requests. A separate four-call
      fresh-prefix/immediate-replay probe observed cache reads and lower charges;
      this does not establish production savings or a cache expiration deadline.
- [x] Verify stable tool ordering, instruction serialization, and prefix continuity
      in actual outgoing provider requests, not just the assembled instruction string.
- [x] Expose supported retention modes, minimum cacheable sizes, cache pricing,
      and cache scope through shared capabilities supplied by adapters. Unknown
      connections use conservative behavior without provider-specific environment variables.
- [x] Track last relevant model request or confirmed cache reuse, connection/model
      identity, and matching prefix coverage. A recent user message alone is insufficient;
      background requests may refresh a cache and model or routing changes may invalidate it.
- [x] Treat warmth as a prediction, not a guarantee. Compare predicted reuse against
      reported cache reads. Do not infer an exact retention deadline for a provider that
      only documents typical behavior.
- [x] Evaluate preserving and appending useful context while likely warm versus
      cheaply selecting smaller existing context while likely cold. A cold prediction
      never initiates paid compaction. Context limits always take precedence.
- [x] Keep cache timing metadata outside the prompt. Do not send keepalive requests
      merely to maintain warmth. Do not regenerate summaries after every message.
- [x] Test policy timing with a fake clock. Run explicit live warm/cold experiments
      separately; reset or document cache state so strategy comparisons are not biased.

Acceptance: policy decisions respect configured capabilities and report observed
cache effectiveness. Tests cover short gaps, long gaps, changed prefixes, model
switches, and background activity without waiting on wall-clock timers offline.

### 8 Compare strategies and choose defaults

- [x] Verify GPT-6 Luna availability, exact identifier, context limits, cache support,
      and current pricing through the configured connection before paid execution.
      Use the existing generic model connection rather than a model-specific integration.
- [x] Compare the current baseline, recent context plus original-history retrieval,
      recent context plus snapshots and linked-run retrieval, and cache-aware selection.
      Use identical fixtures and repeated trials with recorded random seeds.
      The initial four-policy matrix is preserved. Latest-source retrieval and
      snapshots each passed the same 18 workflows three times. Retrieval cost
      USD 0.06821946 versus USD 0.076096435, with median/p95 latency 9.273/38.978
      seconds versus 9.633/36.840. The baseline failed distant recall; unknown
      retention makes cache-aware selection equivalent to snapshots offline.
- [x] Measure snapshot and summary creation costs both once and across repeated
      follow-up questions. Report when reuse pays back its preparation cost.
      Snapshot assembly and original-history selection require no model calls.
      Three measured short baseline workflows include actual paid compaction;
      the findings reconcile preparation, first answers, and both follow-ups.
      Larger prepared summaries use synthetic seed data, so their production
      preparation cost and reuse break-even remain unknown. Paid preparation is
      not selected without measured expected savings.
- [x] Compare retaining already-short original history with replacing it by
      snapshots. Use a bounded token allowance rather than a fixed message count;
      include the additional retrieval calls in the cost comparison.
      The findings table includes three measured three-question workflows per
      policy, their preparation and retrieval overhead, and uncertainty limits.
- [x] Set quality acceptance thresholds from the baseline before tuning defaults.
      Report factual success, unsupported claims, obsolete decisions, isolation failures,
      latency distributions, and full workflow cost. Security failures are not traded
      for cheaper inference.
      Require zero unauthorized reads or actions in deterministic security fixtures,
      preservation of current requests and corrections, and no quality regression
      against the repeated baseline. Record a tolerated latency/cost tradeoff before
      choosing a default, with sample counts and uncertainty for small live suites.
- [x] Implement the simplest strategy supported by the results. Keep unsupported
      capabilities on a safe fallback and avoid speculative configuration options.
- [x] Resolve any contradictory search guidance exposed by live qualification.
      Single-keyword full-text search and cursor continuation must agree between
      system guidance and tool descriptions. Preserve failed runs and verify the
      corrected guidance in a new identified comparison before default selection.
      The targeted final-guidance diagnostic passed all twelve exact/paraphrase
      samples. Full final-source qualification remains a separate default gate.
- [x] Recheck the latest runtime against the live rich-tool fixture before choosing
      a default. Preserve all twelve cursor steps and complete tool pairs without
      redundant reads. Offline success alone does not qualify a candidate.
- [x] Audit effective cache controls inherited from the SDK as well as explicit
      connection settings. A one-hour cache-write request must have a known applicable
      price before inference or reservation, including implicit SDK defaults.
- [x] Publish sanitized reproducible reports and update the verification documentation
      with commands, pricing assumptions, findings, limitations, and chosen defaults.

Acceptance: the final recommendation demonstrates reliable retrieval and context
continuity, accounts for preparation costs, and identifies where caching helps.
No savings claim is made from token counts alone when pricing is unknown.

For each candidate, compare total workflow cost: uncached input, cache reads,
cache writes, output, retrieval calls, and any summary preparation or maintenance.
Show both the first question and repeated follow-ups. Approve paid preparation
only when measured expected savings exceed its cost without failing the quality
gates. A five-minute timer is a configurable prediction input, never a universal
cache guarantee or a reason to invoke a model.

### Default-selection gates

Apply these gates before tuning or selecting the production default. Preserve
initial reports and graders; corrected fixtures or runtime changes require a new
identified comparison rather than rewriting an earlier result.

- Zero unauthorized reads, writes, approval effects, or disclosure of inaccessible
  or cleared history in deterministic security fixtures. Report strict answer
  grading separately from persisted security effects.
- Preserve current requests, subsequent corrections, durable constraints, and
  recognition of absent facts without regression against the repeated current baseline.
- Pass every distant exact-fact and paraphrased-topic sample in the qualification
  suite. A cheaper strategy that loses necessary original facts does not qualify.
- Among qualifying strategies, select the simplest strategy with the lowest
  complete workflow cost. Report median and p95 latency alongside cost. A candidate
  with higher latency must have a documented cost or quality benefit before selection;
  latency alone cannot justify violating the quality gates.
- Publish sample counts, repetitions, failures, and uncertainty. Two trials per
  fixture are exploratory evidence, not a precise reliability estimate. If
  unknown retention makes two policies identical, their stochastic answer-score
  difference is not evidence of a cache-policy benefit.

Use one cumulative spend guard across a live comparison and its follow-up probes.
The current implementation run has an authorized USD 5 cumulative comparison cap;
the CLI's general default is also USD 5. Increasing the current cap requires explicit
authorization. Do not restart a timed-out observation as a second paid process.

## Verification and delivery

Use deterministic offline checks for contracts, authorization, accounting,
retrieval, context budgets, and cache policy. Run focused unit tests and the Pi
protocol suite for runtime changes, and product integration checks for database
and executor changes. Do not routinely run desktop Electron E2E locally.

Use synthetic data only. Keep credentials, private connection files, raw provider
payloads, personal information, and local machine identifiers out of tracked
fixtures, reports, commits, and PR text. Preserve unrelated working-tree changes.

Do not add a UI merely to expose implementation details. If a UI change becomes
necessary, follow the repository's shared UI, copy, and CI screenshot requirements.
If a PR is created, follow the repository's PR watch instructions until CI and
automated review are complete. Do not merge without authorization.

Completion requires implemented and verified behavior, reproducible evidence,
updated documentation, and a final account of remaining limitations. Mark paid
evals not run if the connection, pricing, or budget cannot be resolved; finish all
independent implementation and offline verification first.

## Goal prompt

Complete `docs/context-and-evals-tasks.md`, beginning with its Next goal handoff
and an audit of the current evidence. Reuse verified work; do not repeat completed
implementation phases without a reason. Preserve unrelated
working-tree changes and the existing prompt-order fix. Start by preserving full
Pi usage and making eval accounting trustworthy, then establish a baseline before
changing retrieval and context selection. Explore message snapshots and linked
background work against the baseline. Context selection must be free of inference;
cache expiry alone must never trigger paid compaction or keepalive requests. Use
synthetic fixtures, deterministic offline tests, shared provider-neutral contracts,
and existing model connections. Run GPT-6 Luna comparisons only with verified
availability, pricing, credentials, and the configured spend cap. Update this
checklist with evidence and produce a reproducible quality, cost, caching, and
performance comparison. Preserve the cumulative live spend already incurred;
obtain explicit authorization before increasing its cap. Do not choose a default
until a full final-source qualification passes the stated gates. Do not merge a PR.

## Decisions and evidence

Record implementation choices, test results, sanitized report locations, measured
tradeoffs, and unresolved limitations here as the goal progresses.

At plan handoff, the working tree contains partial usage accounting, scoped history
retrieval, deterministic context and cache helpers, and eval reporting changes.
The Pi runtime integration, complete outgoing-prefix verification, live strategy
comparison, and default selection still require a goal audit and completion.
Existing reports in `docs/evals/` are inputs to that audit, not evidence that the
whole checklist is complete. The implementation goal resumed after this handoff.

### Runtime integration evidence

- The runtime invokes the shared context policy inside the guarded provider call,
  before spend reservation, for both main agents and subagents. Screenshot pruning
  still runs first. Generic configured cache retention is forwarded to Pi.
- `packages/testkit/src/pi-offline.test.ts` verifies actual outgoing HTTP requests
  for retrieval, snapshots, and cache-aware strategies, oversized tool-result
  shortening, intact tool pairs, delegated tool loops, and rejection of oversized
  required input before provider invocation or spend reservation. All 11 tests passed.
- The helper suites verify resolved credential and routing-header changes,
  compressed-prefix reuse, unknown cache retention, fake-clock timing, configured
  image estimates, and preservation of current requests and tool-result images.
  UTF-8 bytes and framing provide a conservative text estimate rather than an
  exact tokenizer count. Unknown images use their encoded bytes; this is not a
  universal upper bound for every provider's vision processing. Provider-specific
  image estimates can improve this bound. Required content that cannot fit the
  estimated budget fails explicitly instead of being silently discarded.
- A full offline run with four workers and a supported Node release passed 3,740
  tests across 363 files; 164 opt-in tests across 30 files were skipped. Subsequent
  security and accounting fixes require their focused integration checks and a
  final verification pass before this proves the final implementation.
- Type checks passed for all 19 non-mobile packages and mobile TypeScript directly.
  The ordinary project command encounters stale installed `tsx` launcher paths;
  mobile's additional Expo compatibility check finds pre-existing installed-version
  mismatches. Package declarations and unrelated lockfile edits were preserved.
- Project lint passes with existing warnings. New public eval JSON reports were
  formatted. No desktop Electron E2E was run locally.
- The initial shared-budget live strategy matrix is preserved as a partial report.
  Default selection and
  measured quality/cost/cache conclusions remain incomplete.

### Retrieval and cache protocol evidence

- Local history retrieval has bounded search results, message-window pagination,
  within-message text pagination, and separate linked-run, outcome, and artifact
  cursors. Original facts remain reachable without sending the whole catalog.
- PostgreSQL and executor/Pi fixtures cover group membership, channel visibility,
  clear/delete behavior, long originals, linked background work, and structured
  secret redaction. The expanded focused integration checks passed 41 tests;
  one product fixture reads 101 artifacts through 21 bounded tool calls.
- Snapshots derive from original message text and persisted run state. They carry
  anchors, coverage, timestamps, version hashes, and open-work references without
  a model call. They remain navigation aids rather than authoritative approvals.
- Actual outgoing Pi protocol fixtures verify supported retention controls.
  Unsupported explicit controls fail before HTTP or spend reservation instead of
  silently pretending they were applied. Omitted controls use the audited SDK short
  default, preventing process-level SDK settings from silently requesting long
  retention. Provider behavior remains advisory; configured timing metadata alone
  does not change provider billing.
- Cache predictions use the relevant model request's start time and matching
  prepared prefix, with connection, credential, routing, and model scope. Fake-clock
  checks cover responses that finish after retention expires and out-of-order
  concurrent completions. Unknown retention stays unknown; explicit disabled
  caching predicts cold. Timing metadata never enters the prompt.
- Three simplification reviews produced eight distinct applicable improvements,
  covering shared usage semantics, exclusive attribution, cache protocol validation,
  redundant persistence, and context-estimation work. Focused verification passed
  146 tests after those changes. Final broad checks remain a completion gate.

### Usage accounting evidence

The final focused eval suite passed 50 tests across seven files, including report
arithmetic, nullable measurements, operation attribution, concurrent reservations,
pricing failures, explicit not-run CLI output, and cleanup of late-created runs.
`docs/agent-verification.md` documents reproducible commands, full-workflow costs,
first-response timing, cache eligibility, and spend-guard limitations.

`pi-usage.test.ts`, the actual HTTP cancellation/classification fixtures, ledger
tests, and `usage-accounting.postgres.test.ts` verify the usage fields and their
unknown semantics. The persisted product fixture covers normal calls, subagents,
partial failures, auto-review setup, compaction, concurrent duplicate delivery,
clear/delete retention, cancellation, and late arrival after run deletion.
The resumed focused checks passed 113 tests and the expanded PostgreSQL fixture.

An awaited producer usage sink records incurred usage independently of whether
the executor still consumes events. Successful sinks acknowledge the event;
other runtimes retain the idempotent event fallback. Call IDs prevent double
accounting. Lifecycle deletion may null the optional run relation while retaining
durable parent attribution. Retrieval is one exclusive model-call cost bucket
for requests that ask for or immediately consume history tools; subagent, setup,
and compaction attribution take precedence.

Provider measurements absent from the audited protocol remain unknown. Evaluation
guards disable hidden SDK retries and await reservation settlement before the
terminal event. Existing cross-process stop responsiveness can wait for the lease
heartbeat; the accounting fixture explicitly aborts after durable cancellation
to verify cost retention independently of that pre-existing timing behavior.

### Current verification audit

The latest broad offline pass at this audit point passed 3,796 tests across 370
files; 172 opt-in tests across 32 files were skipped. All 19 non-mobile package
type checks passed and mobile TypeScript passed directly. Lint passed with 21
existing warnings and the existing schema-version notice. Two cache protocol
files needed formatting only and were corrected. No Electron windows were opened.

The accounting, authorized-query performance, snapshot pagination, active-state,
and immediate cache-reuse audits are complete. Remaining completion gates are
the terminal live qualification report, final default selection, its verification,
and the final quality/cost findings. Live cache retention expiry has not
been measured; immediate prefix replay measures reuse, while offline fake-clock
tests exercise expiry decisions. Unknown provider retention remains unknown.

### Retrieval, state, and measured cache audit

`docs/evals/history-retrieval-offline.md` records the original-backed snapshot
index/page design and actual authorized 10,000-message query plan. The query uses
the GIN expression; observed warm synthetic executions were below one millisecond,
without a brittle timing assertion or a production latency guarantee. Fixtures
reconstruct long originals and page every linked run, outcome, and artifact.
Saved memory and open scratchpad constraints survive dropped old context, and the
actual scripted product workflow persists a proposal with the constraint intact.
The latest combined PostgreSQL accounting and history run passed 13 tests.
An open investigation represented only by a subagent task is indexed before its
result exists; a forward migration updates the GIN expression. Its database test
finds the task, reads the original-backed snapshot and current run status, denies
channel-invisible access, and verifies that clearing removes the source.

The rich-loop comparison exposed malformed structured-result truncation. Bounded
policies now preserve complete JSON and pagination controls, shorten evidence text
with explicit omission metadata, and keep history offsets exact. Required metadata
that cannot fit gives valid retry JSON or an explicit budget failure. Actual Pi
fixtures complete twelve dependent oversized diagnostics under all three candidate
policies in a configured 4,096-token window. The original strategy keeps its legacy
behavior for baseline reproduction. Already-aborted next turns no longer create
fictitious unknown-usage calls.

Search originally matched its own incoming question. A backend-owned historical
sequence boundary now excludes that question and current-run output from search;
explicit reads and linked outcomes retain their existing authorized visibility.
The search interface documents literal keyword matching, its five-result cap, and
the exact pagination handoff. Earlier diagnostic failures remain documented and archived rather
than being relabeled as success.

The integration fixtures also exposed globally reused provider tool IDs. Effect
keys now include the run and Pi agent scope, and stored ownership is verified before
replay. Identical provider IDs across spaces, runs, and helpers produce independent
effects; same-owner retries deduplicate. Ambiguous pre-upgrade Pi records fail
closed and require outcome verification instead of repeating an uncertain effect.
Existing approved-argument replay remains intact.

`test-report/evals/archive/history-cache-prefix-probe.json` records four direct model calls costing
USD 0.00106534 in total. Fresh and changed prefixes read zero cached tokens; both
immediate replays read 3,882 cached tokens. Each replay cost USD 0.00004312 versus
USD 0.00048955 for its fresh counterpart, about 91.2% less for these exact prefixes.
All four advisory predictions matched the observed hit/miss outcome. Latency was
mixed. This measures immediate reuse, not expiry or general production savings.
No inference generated the probe's synthetic prefix or navigation snapshots.

### Qualification and rich-tool evidence

The subsequent paired qualification passed all 12 distant recall samples with
snapshots and preserved corrections, constraints, absence, and linked outcomes.
It nevertheless exposed two failed rich-tool workflows, so snapshots has not
qualified as the default. The preserved partial report identifies the requested
bug-driven stop, the in-flight baseline deadline/cleanup failure, and all 32
unattempted workflows. Unknown call costs remain unknown; the cumulative guard
retains their conservative reservations as spend rather than treating them as free.

A real product/Pi/PostgreSQL reproduction using the exact seeded rich-loop case
proved that its JSON and cursors were intact. Each verbose result occupied about
25.7k bytes, leaving only one tool step in selected context. New policies now
shorten verbose evidence structurally before it displaces loop progress, using
the existing 12k result allowance while preserving controls and original-history
offsets. The original strategy retains its baseline clipping. Omission is explicit;
no model produces this shortened representation.

The first structural-shortening reproduction passed offline, but its live probe
still repeated reads. Compacting older result bodies to about 1k bytes improved
progress; a subsequent live probe recovered the correct answer in 23 reads and
therefore failed the unchanged twelve-read gate. Both failed reports are retained.

The latest runtime uses the resolved model context window and output reserve
instead of an additional arbitrary 32k allowance that discarded active progress.
Recent history and the navigation catalog remain bounded. A product regression
with synthetic verbose assistant prose retains all twelve cursor steps, complete
call/result pairs, and the current deployment constraint. Its selected estimate
reaches 128,207 tokens, beyond the former allowance but within the configured
model budget. The combined check passed 26 tests, including 14 PostgreSQL tests,
and type checking passed. This is offline evidence, complemented by the live probe
below; broader repeated qualification and final default verification remain gates.

Actual SDK protocol fixtures reproduced an implicit one-hour cache-write request
when a process-level default selected long retention. Omitted shared controls now
pin the audited short default; explicit supported controls remain available.
One-hour requests require applicable write pricing before reservation or inference.
Another deterministic fixture proved that an upper token estimate could cross a
cheaper pricing tier while actual usage stayed in the more expensive base tier.
Reservations now use the highest applicable rates across every reachable tier.
The combined focused cache, usage, transport, budget, and CLI check passed 55 tests.

The latest two-trial live probe passed every criterion. Each workflow read all
twelve diagnostic segments exactly once, retained the pending approval, and made
fourteen model calls. Total known cost was USD 0.008439515; workflow latencies
were 31.765 and 37.818 seconds. Repeated broader qualification remains incomplete.

The new current-strategy v2 baseline completed twelve workflows with clean teardown:
five passed. Balanced ambiguity passed two of three trials; the failing answer
did not request clarification. Repeated recall at 100 messages passed all three
turns in each of three trials. At 1,000 and 10,000 messages, all six repeated
workflows failed distant recall. The baseline made 36 model calls costing
USD 0.0108437. Its 100-message workflows incurred actual compaction charges of
USD 0.0004635, USD 0.000454, and USD 0.000456. Larger prepared summaries remain
free synthetic fixture setup and cannot establish real preparation savings.

The snapshots qualification completed all 54 workflows, with 50 passing and clean
teardown throughout. All twelve distant recall samples passed, as did corrections,
constraints, linked outcomes, six rich loops, and all three turns in each of nine
repeated workflows. One absence answer volunteered an unrelated known label;
three ambiguity answers volunteered candidate labels instead of obtaining the
missing project selection. Those strict failures remain documented and archived and prevent
default selection. Full charges were USD 0.097921115 across 289 model calls.

The shared history guidance now tells the bot to state absent facts briefly without
adjacent facts and to clarify an unselected project before giving candidate facts.
New identified trials must verify this change; no earlier failures are regraded.
The ambiguity fixture was extended in a separate version to recognize
a real persisted clarification card while continuing to reject unexpected requests
for assistance, secret input, approval, and candidate-label disclosure.

Per-question accounting now partitions the final durable ledger by question run
and delegated parent run, exposing only step numbers. Compaction and unattributed
background calls have separate buckets. Model-call, cost, and token reconciliation
retain unknown values. This adds no wait or scheduling change between questions.
Live per-question measurements are now available in the later reports; aggregate
charges from older reports cannot establish the first-question cost or each
follow-up's cost. The explicit clarification fixture accepts a valid persisted
project-selection card, while rejecting secret requests, approval effects,
candidate fact disclosure, and unexpected requests for assistance. Earlier fixture
versions and failed reports remain intact.

### Latest qualification and short-history findings

`test-report/evals/archive/history-concise-clarification-pilot.json` passed all nine workflows.
The three clarification trials persisted project-selection cards without revealing
candidate labels. Known cost was USD 0.009844045 across 27 model calls.

`test-report/evals/archive/history-current-final-measurement.json` passed three of six workflows.
All three repeated 100-message workflows passed every turn; all three balanced
clarification workflows failed. The 100-message workflows averaged USD 0.0012767017
including two real compaction calls per workflow. Their mean preparation charge
was USD 0.0004165. This establishes actual charges, not a causal payback threshold.

`test-report/evals/archive/history-snapshots-final-qualification.json` completed all 54 workflows
with clean teardown. It passed 52: all 42 non-distant workflows and ten of twelve
distant samples. Two paraphrase answers failed to retrieve available original
facts. One abandoned the broader keyword query's pending cursor after narrower
queries were empty; the other never tried the single project keyword. Known cost
was USD 0.09711853 across 292 calls, with median latency 11.315 seconds and p95
37.932 seconds. These failures prevent default selection.

The latter report's repeated 100-message workflows averaged USD 0.00252723, with
no paid preparation. Snapshot selection caused extra retrieval calls and made
these small workflows more expensive than the current baseline. Provider cache
state and differing selected context prevent attributing the difference solely
to compaction. Free context assembly alone is not evidence of lower total cost.

The subsequent adaptive policy retains already-short originals within a bounded
wire-equivalent token allowance. Actual product/Pi/PostgreSQL checks passed three
turns for both snapshots and cache-aware policies: original facts and constraints
were present on every request, with exactly three foreground calls, no history
lookups, and no compaction. Long histories retain bounded navigation. The focused
helper suite passed 34 tests and adapter/testkit type checks passed. The combined
integration suite initially passed 26 of 28 tests. The two group paging fixtures
now declare their intended 160,000-token model window and 4,096-token output
reserve instead of inheriting the compatible model's smaller fallback. Required
navigation metadata reached 1,713 bytes per page; both applications consumed all
101 artifact cursors. Product budget behavior was unchanged, and separate tiny
window tests retain the valid retry response. The latest serialized check passed
all 66 tests, including 20 PostgreSQL checks. These changes and the corrected
keyword/cursor guidance still require a fresh matched live qualification.

The latest broad offline run passed 3,807 tests across 372 files, with 178 opt-in
tests across 34 files skipped. All 19 non-mobile package type checks and mobile
TypeScript passed. Lint passed with 21 existing warnings and one existing notice.
All 19 preserved local JSON reports parsed and passed the credential/local-path scan.
Final default wiring, if selected, will require its own verification.

The corrected-guidance diagnostic passed all twelve distant exact/paraphrase
samples, costing USD 0.01285668 across 46 model calls. The subsequent adaptive
100-message comparison passed every turn in all three workflows, with no tools,
compaction, or summary generation and exactly three model calls per workflow.
Its total charge was USD 0.002755125. Mean first-question and follow-up charges
were USD 0.0007609667, USD 0.00007945, and USD 0.0000779583; mean complete cost
was USD 0.000918375. This was about 28.1% below the measured current workflow and
63.7% below the earlier forced-snapshot workflow. Three trials with uncontrolled
provider cache state establish neither precise reliability nor causal preparation
payback. The full final-source qualification remains mandatory.
The two new archived sanitized reports are `test-report/evals/archive/history-keyword-qualification.json`
and `test-report/evals/archive/history-adaptive-repeat-cost.json`; all 21 preserved local JSON reports
parsed and passed the credential/local-path scan after publication.

The cumulative guard has charged USD 0.938278085, leaving USD 0.061721915 under
the authorized USD 1 cap. This includes a conservative charge for an uncertain
call and is not a claim about the provider's final bill. Both diagnostic processes
are terminal, owned databases were removed, and reservations are zero. Carry this
balance forward rather than resetting the cap for another command. A request to
increase the cumulative cap was subsequently approved at USD 5, leaving
USD 4.061721915 before the full qualification. See `docs/evals/history-findings.md` for the preserved
comparison, per-question accounting, and failed diagnostics.
