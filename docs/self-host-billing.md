# Billing

Charge for hosted use with Stripe: an own-key plan, monthly model credits and top-ups.

## Plans

Billing stays off unless `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are both set (see
`.env.example`). Enabling billing offers a monthly own-key plan for a personal model connection or
monthly model credits in USD: $10, $20, $50, $100, $200, or $500. One-time top-ups use the same
amounts. Monthly credits expire at the end of their service period; one-time top-ups do not expire.
The hosted computer is included in both paths, and monthly credits include the own-key plan.

`BYOK_MONTHLY_PRICE_CENTS` in `@rakazo/contracts` sets the own-key plan's price; `null` makes it
free and ends paid own-key subscriptions at their period end. Runs check access on the server, so a
lapsed organization's bots and routines stop until it subscribes.

## Model credits

Configure the managed default model through the existing model connection settings. The default
OpenRouter model is Luna 6; customers can choose another available model, with its usage deducted
at model cost. In credit mode, the configured hosted provider uses Rakazo's key even when a personal
key for that provider is saved. Switching back to BYOK restores that connection. Personal connections
to other providers continue to use their own keys and never debit Rakazo credits. Hosted calls reserve an upper cost estimate atomically before starting, then settle
to reported or catalog-priced usage. Unknown usage retains its reservation for reconciliation.

`STRIPE_PRICE_ID` is optional and only needed to display the legacy seat price. Existing live seat
subscriptions retain their access and billing portal. Upgrades charge the prorated difference
immediately and add the amount collected to the credit balance; a failed payment leaves the plan
unchanged. Downgrades lower the next renewal without charging now or removing credits.
Credit purchases require settled payments; webhook
replays do not add credits twice, and refunds reduce the remaining account balance.

Monthly funds are spent before top-ups. Each grant has an audited allocation lot, so reservations
retain their funding source across renewal: unused monthly holds expire when released, while
purchased top-ups remain available. Prorated upgrades share the original period end. Expiration
creates a financial journal delta and runs before balance reads, reservations, settlements, and
background recovery. Unclassified legacy balances are preserved as non-expiring funds.

## Accounting

Postgres owns accounting. `billing_audit_events` is an append-only journal enforced by database
triggers; credit entries, usage rows, and balances are projections. Each managed call shares one
`callId` across reservation, durable provider receipt, usage, and settlement. Provider generation
IDs, token buckets, cost provenance, and pricing snapshots are retained. Usage and settlement
commit together, and journal/usage history survives clearing messages or deleting a bot or
organization. Corrections append evidence rather than rewriting earlier journal events. Existing
rows receive explicit baseline events when the migration runs; earlier history cannot be recovered.

The API/worker reconciler recovers saved receipts and, when supported by the configured provider,
fetches authoritative generation costs for interrupted calls and estimates. Retries use leases and
idempotent settlement. Unverifiable calls retain their holds and become `needs_review` after six
attempts. An hourly, paginated audit rebuilds drifted balance caches from the journal and records
repairs. Investigate `Model credit hold requires review` logs using the shared call ID; do not turn
missing provider evidence into a zero-cost settlement.

OpenRouter inference requests include the normal Rakazo user ID in `user`, `HTTP-Referer`
(`https://rakazo.com`), and `X-OpenRouter-Title` (`Rakazo`). These values are sent only to OpenRouter's
HTTPS inference endpoints, never to compatible custom hosts. Recovery uses the existing configured
deployment credential; no Redis or external accounting service is required.

## Stripe setup

The adapter pins Stripe API `2026-09-30.endive`. Configure webhook destinations for your own account,
using snapshot payloads on the same API version. Subscribe to all `customer.subscription` events,
`customer.deleted`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, and
`charge.dispute.closed`. Credit Checkout restricts payment methods to cards. New subscriptions
explicitly retain classic billing mode so API upgrades do not change invoice/proration behavior.

For local testing, forward Stripe test events to `/api/v1/billing/webhook`. Use the signing secret
from `stripe listen` and test API credentials; keep them in an ignored environment file.

## Support chat

`CRISP_WEBSITE_ID` on the API shows a [Crisp](https://crisp.chat) support chat on the paywall.
