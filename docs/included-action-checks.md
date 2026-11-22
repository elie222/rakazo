# Included action checks: operator setup

Hosted model-credit billing enables the included decision checker for members without an
account or Space approval-model choice. The existing Auto / Ask / Never modes, block rules,
mandatory approvals and ordered backups still apply. A deliberate ask or uncertainty never
advances to a backup. When a member's own checker or backup cannot run, the included checker
decides as the last backup. Errors and timeouts ultimately ask the owner. The existing run-access gates govern eligibility, including trials and free access periods.
There is no second paid-history gate that can make a configured checker unavailable. Personal
checker choices and general LLM deployment checkers keep their existing funding behavior. A deployment decision checker without a personal connection records operator expenses.

The default uses the decision model in the adapter catalog when the deployment has its existing
API connection key. No user setup, additional checkout, provider subscription login or personal
connection guessing is involved. Self-hosting keeps the existing default resolution and requires
no hosted service. Its checker usage remains visible in the normal usage views; only hosted
operator expenses are excluded from customer totals. An explicit deployment checker selection
still wins. A matching backup does not change the primary checker’s funding source.

## Remaining operator work

1. Apply the additive `operator_usage` migration with the normal release migration process.
   It adds `UsageRecord.fundingSource`, defaulting old rows to `customer` for compatibility.
2. Configure the existing deployment connection secret on API and worker processes:

   ```dotenv
   OPENROUTER_API_KEY=fake-operator-key-replace-in-secret-manager
   ```

   Hosted billing must already have `modelCreditsEnabled` enabled through the existing billing
   composition. The key needs access to `typesafe/jev-1.14` on the Decisions endpoint.
   Alternatively pin the same choice with the existing generic settings:

   ```dotenv
   RAKAZO_AUTO_REVIEW_PROVIDER=openrouter
   RAKAZO_AUTO_REVIEW_MODEL=typesafe/jev-1.14
   RAKAZO_AUTO_REVIEW_TIMEOUT_MS=10000
   ```

   Legacy direct decision-provider configuration still works and now records expenses too.
   Each decision model's catalog entry sets the probability a pass needs, tuned in evals; setting
   `RAKAZO_AUTO_REVIEW_MIN_CONFIDENCE` replaces it with one confidence floor for every model.
3. Before rollout, review the [versioned examples](../packages/testkit/src/evals/suites/approval.ts)
   and the rubric identified by
   [`APPROVAL_DECISION_RUBRIC_VERSION`](../packages/adapters/src/approvals/decision-auto-review.ts)
   (its state may include the owner's `ownerEarlierMessages`). With an authorized test key, run the existing CLI explicitly:

   ```sh
   pnpm test:evals --suite approval --live --provider openrouter \
     --model typesafe/jev-1.14 --api-key-env APPROVAL_EVAL_KEY \
     --trials 1 --timeout-ms 10000 --spend-cap-usd 0.10 \
     --output /tmp/approval-calibration.json
   ```

   The cap bounds reservations, not the provider's invoice. Review false passes, false asks,
   errors and latency separately; retain the report with its fixture/rubric/code versions and
   reported versus estimated costs. Errors are unqualified results, never safety passes.
   This change ran no live calls and establishes no production calibration.
4. Use normal operator accounting to review `usage_records` where `fundingSource = 'operator'`.
   Rows retain user, Space, bot, run and operation attribution without prompt content. Each call
   records intent before dispatch, then request IDs, usage evidence, cost source, pricing version
   and a rate/source snapshot. A process loss leaves `dispatch-pending` with unknown cost;
   reconcile it against the provider invoice rather than calling it free. There is no automatic
   invoice reconciliation in this change. Provider-reported amounts are confirmed evidence;
   catalog or request-token estimates remain estimates. Unknown token counts stay null.
   Included expenses are excluded from customer usage totals and never reserve or settle
   purchased model credits.

## Economics and qualification

The catalog snapshot checked on 2026-11-17 prices text input at $0.042 per million tokens and
output at $0, from the [model catalog](https://openrouter.ai/typesafe/jev-1.14) and the
[direct-provider price explanation](https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost).
For example, 2,000 input tokens estimate $0.000084 per check, before any account-specific fees.
Reverify pricing and model access before rollout and after changing the model. Floating legacy
aliases are estimates at the recorded snapshot, not a guarantee of the served model's tariff.
Promotional infrastructure credits are not part of this price or permanent funding policy.

Offline fixtures qualify routing and accounting contracts. They cannot establish real model
accuracy, model availability for an operator account or production latency. Personal-connection
model shortcuts are intentionally deferred; the universal included checker does not need them.
