# Deployment model credit offerings

`MODEL_CREDIT_OFFERINGS` is deployment-owned JSON. It is optional: when absent,
existing single deployment model configuration and pricing continue to apply.
An invalid or empty environment value fails closed. Never send this configuration
from a client or put credentials in it.

Example only; all IDs are fake and the numeric rates are test values, not a
commercial recommendation:

```json
{
  "defaultOfferingId": "standard-example",
  "offerings": [
    {
      "id": "standard-example",
      "connectionId": "operator-connection-example",
      "provider": "provider-example",
      "modelId": "model-example",
      "price": {
        "input": 1,
        "output": 4,
        "cacheRead": 0.1,
        "cacheWrite": 2
      }
    }
  ]
}
```

Each price is the customer USD charge per million tokens in that measured bucket.
The input rate must be positive; output and cache rates must be nonnegative.
Use zero customer cache rates for protocols that do not report cache buckets. A decision
protocol that cannot enforce an output limit requires a zero output tariff; a positive
output tariff is refused before dispatch rather than reserving an incomplete bound. Prices
are independent of the provider's invoice, free allowance, or promotional credits.
Cache writes use the configured customer write rate regardless of upstream cache
retention; reservations conservatively allow the long-retention bound.

Create a dedicated operator-controlled model connection through the existing
connection settings, which seals its key in the existing secret store. Use its ID
as `connectionId`. Its provider must exactly match the offering. Only API-key
connections qualify; custom endpoints and personal sign-ins require BYOK. Put
account, gateway, project, and region settings on that connection, never in this
catalog. A system-scoped read loads only the connection named in the validated
operator allowlist, after normal model resolution has selected deployment funding.
The provider must have an existing adapter. One provider/model pair has at most
one approved offering. The operator must verify the model ID is supported by that
adapter and accessible on the selected connection. Only offerings with a readable API-key
connection appear as credit choices. Role saves recheck the connection, and execution checks it
again; personal choices remain available when an operator connection is withdrawn or removed.

Set the same JSON on the API and workers. Enable the existing model credit billing
setting and configure the existing checkout/payment integration separately. This
change creates no payment product or price and makes no purchase.

To withdraw an offering, remove it and choose another approved default. To withdraw
all offerings, keep the variable set to:

```json
{ "defaultOfferingId": null, "offerings": [] }
```

Do not unset it to withdraw service: absence restores legacy deployment behavior.
Withdrawal prevents new resolutions but does not delete balances, expire purchased
credit lots, or change existing holds. Calls already resolved keep their tariff;
reservations persist the tariff before dispatch. When an interrupted call has a recoverable request ID, supported providers can recover measured
token buckets through the original stored connection and price them at the saved tariff, even
after withdrawal. Unknown usage retains its hold for review; it is not replaced with a free
provider bill, current prices or an estimated tariff.
A lost response after dispatch remains uncertain. Cancellation known to occur
before dispatch releases the hold with a zero-cost not-started receipt.
Existing credit-lot expiration policy remains unchanged.

Roll out the code to every API and worker before enabling the variable. Drain old
workers and their in-flight calls first: older reconcilers do not understand the
new tariff receipt marker. The additive migration adds nullable credit offering IDs
on account and Space role choices and includes funding in their uniqueness indexes.
Old code continues to read and write its existing rows while the variable is absent.
Enable the variable only after old processes have drained. Rollback with outstanding
tariff holds requires keeping a compatible reconciler until those holds settle or
receive operator review. Never rewrite outstanding receipts to current prices.

## Selecting funding

Personal connections retain precedence. A missing explicitly selected personal
credential fails rather than falling through to a deployment key. The shared run
resolver and observer enforce approval for reasoning calls, auxiliary models and
backups; the team decision path uses the same approved connection loader. Direct
summary callers without a metered resolver fail closed with this configuration.
Speech and deployment approval checks do not acquire customer tariffs here.

In model settings on web, desktop, and mobile, each approved offering appears under
“Rakazo credits”. Personal connections remain separate entries, including when they
serve exactly the same provider/model. The choice persists for the account or the
Space override being edited. The main model and each auxiliary role can choose
funding independently. A fallback to a different funding source happens only when
that source is explicitly present in the saved fallback list.

The saved offering ID must still match the provider/model at execution. Removing
or replacing it fails that choice instead of trying another offering or a personal
credential. Personal secrets that disappear fail instead of using a deployment key.
Backups and computer checkpoints carry the selected funding identity. Summary and
team-decision calls preserve the member's selected main funding. Bot provider/model
overrides keep personal precedence; bots following the main model use its explicit
funding choice. Existing rows without a connection retain legacy resolution.

Deployment-provided speech and default approval checking remain operator expenses;
they need the separate infrastructure configuration. This catalog is not their
credential store or an operator-expense ledger. Explicit member checker choices
use the funding selected on that role; an included deployment checker must not be
routed through a customer credit observer by the composition root.

Operators still need to choose the initial supported providers and models, tariffs,
markup, cache pricing policy, withdrawal schedule, purchase products, and customer
terms. Vendor promotional credit expiry must control offering availability, not
customer balance expiry or customer prices. No initial commercial policy is implied
by the example.

## Integration with included services

Included deployment decision checks use an explicit operator-funded resolution path. The approved
customer catalog neither grants access to those credentials nor restricts the configured included
checker; its observer records operator expenses rather than purchased-credit charges. An explicitly
selected credit-funded member checker retains its approved offering and customer tariff. Personal
checker connections retain their own credentials. These funding sources cannot be combined.

Model transports settle durable receipts before publishing priced customer usage, including
when a response stream fails, while
unknown provider costs remain unknown. Only the operator expense observer records inferred
checker estimates. Speech uses its own deployment connection and allowance accounting.

Apply the approval usage and speech migrations before the credit-offering migration. Enable the
catalog only after all API and worker processes enforce the new funding contract.

Legacy backup clients may submit provider/model-only rows: an unambiguous existing funding pin
is preserved. If the same model already has several funding routes, the update is refused until
one is selected explicitly. Owner-saved deployment defaults remain valid only when approved;
otherwise the configured default offering applies. Catalog reads isolate unavailable operator
secrets from personal models and share each operator connection read within that request.
