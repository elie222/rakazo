# Deployment speech

A deployment can supply speech without a member voice key. Leave `DEPLOYMENT_VOICE` unset for
optional, self-hosted operation. Members' explicit account connections, Space copies (including
an empty copy), and bot voice choices retain precedence. A broken member connection is not
silently replaced with an operator-paid one. Device speech continues to run on the device.

The existing call session still sends a recognized utterance through the normal thread/run path,
then speaks its reply. Reasoning keeps its selected connection and funding source, tools and
approvals. Speech costs are operator costs; this path never touches model-credit balances.

## Configure

Apply the additive database migration before enabling the deployment default. Set
`DEPLOYMENT_VOICE` as secret server configuration, a JSON object with:

```json
{
  "provider": "voice-provider-id",
  "connection": { "plaintext": "FAKE_SERVER_API_KEY" },
  "voiceId": "voice-id",
  "pricing": {
    "synthesize": {
      "model": "speech-model-id",
      "unit": "characters",
      "microsPerUnit": 15,
      "maxRequestMicros": 100000,
      "source": "https://pricing.example/speech",
      "version": "operator-reviewed-rate-v1"
    },
    "transcribe": {
      "model": "recognition-model-id",
      "unit": "seconds",
      "microsPerUnit": 100,
      "maxRequestMicros": 100000,
      "source": "https://pricing.example/recognition",
      "version": "operator-reviewed-rate-v1"
    }
  }
}
```

These are illustrative reservation amounts, **not plan quotas or new paid prices**. One USD is
1,000,000 micros. Choose a reservation large enough for an allowed request; admission is atomic
across API instances and Spaces for each account. A reservation is a budget guard, not a provider
spend cap: unexpectedly expensive requests are recorded in full and block further admission.
Configure a provider-side spend limit as well. Upload byte limits do not bound audio duration.

`connection` uses the existing voice connection fields: `plaintext`, optional `baseUrl`,
`sttBaseUrl`, `sttApiKey`, `ttsModel`, `sttModel`. For compatible servers, set the model fields to
match the pricing models. Endpoint fields require valid HTTP(S) URLs and a provider that
supports custom endpoints; unsupported fields are rejected so consent names the actual recipient.
Compatible connections require the main server URL; a separate recognition key requires its own
recognition URL. Startup reuses the provider credential serializer for endpoint, key and effective
model validation. Embedded URL credentials, blocked destinations and keyed public HTTP are
rejected before speech is advertised. Private endpoints require `MCP_ALLOW_PRIVATE_ENDPOINT=true`
at startup and dispatch. Fixed recognition models are validated by the provider descriptor.

The adapter must declare usable metering for both configured models. Reported units must match
pricing units; startup rejects mismatches. Models without reliable usage evidence, including
compatible servers, require explicit `"allowUnmeteredUsage": true` in this JSON. Use that opt-in
only with an operator process for importing cost evidence: every unmetered request retains its
full reservation until reconciled and can exhaust the allowance after a few replies. Token-billed
models also require that opt-in because this policy cannot price mixed token classes automatically.

Endpoint/private-network restrictions remain in force. Keep server keys
out of account settings, client configuration, repository files and logs. Use a dedicated speech
service key, separate from reasoning credentials. No provider purchase or key retrieval is automated.

See the [adapter pricing and calibration notes](../packages/adapters/src/providers/voice/xai/HOSTED.md)
for a concrete existing-provider configuration and official research sources.

All operator-funded speech checks the member's recorded consent for the actual operation's
recipient and current disclosure version in that Space before dispatch or allowance admission.
Web, Electron and mobile ask through their voice disclosure. Automatic messaging voice-note
transcription leaves the attachment without a transcript when that consent is absent.

## Allowances and remaining policy

All paid plans are proposed for inclusion, but quotas, renewal rules and cancellation grace are
undecided. No entitlement or free speech is inferred from the presence of a server key. Until
those decisions are made, an operator explicitly grants an account allowance with the database
owner connection. Missing, expired or exhausted grants do not advertise the included voice, preserving device speech and personal setup. Admission also checks the grant atomically before dispatch:

```sql
INSERT INTO speech_allowances ("userId", "limitMicros", "expiresAt")
VALUES ('fake-account-id', 1000000, '2099-01-01T00:00:00Z');
```

The example amount is a test grant. Operator automation must select eligible paid accounts from
the authoritative subscription state and apply the approved quotas; this change deliberately adds
no paid price, automatic renewal, or model-credit debit. To revoke, expire the grant. To extend,
raise the cumulative limit and expiry. **Never reset usedMicros or delete/recreate an allowance**:
it includes pending reservations, and later reconciliation must still adjust the same counter.
New periods can add an approved amount to the cumulative limit. A period-specific quota system
and automated billing lifecycle provisioning remain operator work once policy is agreed.

## Cost evidence and recovery

`speech_costs` stores authenticated account and Space attribution, local operation ID (`id`),
optional client call correlation (`callId`, untrusted metadata), provider request ID when returned,
operation, configured and observed model/unit, measured billable units, rate, pricing source and
version, reserved/accounted amounts, and estimated/confirmed state. It contains no transcript,
audio, credentials or provider response bodies. Token details are retained when the adapter exposes
them. Token-billed operations remain unresolved until evidence import: this simple policy never
applies a single blended token rate to differently priced token classes.

Admission commits a reservation and pending row before contacting the provider. On success,
matching units yield an estimate using that row's pricing snapshot, refunding unused reservation;
observed overruns count in full. Missing/mismatched units remain unresolved and retain the reserve.
Device speech makes no paid request and creates no operator cost row. Explicit member-owned
connections are not charged to the operator ledger.

If settlement storage fails after speech completes, return the completed result and log the failure; its durable pending row remains available for recovery. Crashes, timeouts and interruptions leave pending rows. Never replay the audio or automatically
refund these: the provider may have billed it. Recover from the provider's usage/invoice export,
using the provider request ID when present, request time and local operation ID. The internal
`confirmSpeechCost` helper requires `runAsSystem` and accepts the operation ID plus
`{ costMicros, source, reference }`. Supply a non-secret, unique evidence reference and provenance;
zero requires evidence of no charge. It adjusts the allowance and confirms the row atomically.
Repeated identical confirmation is idempotent; a changed cost, source or reference is rejected. Tenant SQL cannot edit grants or delete cost evidence; scoped accounting operations use an explicit system context. Preserve
source exports in the operator's private financial system. No invoice API/reconciliation worker
is installed here: the operator must schedule or perform this evidence import. Alert on old
pending/unresolved rows; they intentionally reduce available allowance until resolved.

No production configuration, purchases, paid calibration, browser E2E, or deployment is part of
this change. Offline API, adapter, call-session and PostgreSQL concurrency/recovery tests cover
the implementation. Enable hosted traffic only after setting the policy, provisioning grants,
checking the provider key and measuring the calibration cases below.

A completed request whose settlement write fails still returns its audio or transcript. The error
log identifies `speechCostId`, provider, operation and provider request ID (when available), so an
operator can locate its pending row without transcript, audio or credentials in the log.
