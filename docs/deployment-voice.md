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

Speech priced per character is metered by the server, which counts the text it sends. The adapter
must declare usable metering for the transcription model, and its unit must match the pricing
unit; startup rejects mismatches. Other speech units and transcription models without reliable
usage evidence, including compatible servers, require explicit `"allowUnmeteredUsage": true` in
this JSON. Use that opt-in
only with an operator process for importing cost evidence: every unmetered request retains its
full reservation until reconciled and can exhaust the allowance after a few replies. Token-billed
models also require that opt-in because this policy cannot price mixed token classes automatically.

Endpoint/private-network restrictions remain in force. Keep server keys
out of account settings, client configuration, repository files and logs. Use a dedicated speech
service key, separate from reasoning credentials. No provider purchase or key retrieval is automated.

All operator-funded speech checks the member's recorded consent for the actual operation's
recipient and current disclosure version in that Space before dispatch or allowance admission.
Web, Electron and mobile ask through their voice disclosure. Automatic messaging voice-note
transcription leaves the attachment without a transcript when that consent is absent.

## Allowance

Each organization may spend a fifth of its plan's monthly list price on included speech per
billing period: the own-key tier's price, or the monthly credit amount on a credit plan. A trial
gets the Standard tier's share; a cancelled trial and an organization without a live plan get none.
Yearly plans renew monthly on the day their period began, as the computer allowance does. A
deployment without model-credit billing does not limit speech.

Usage is every reservation and recorded cost from `speech_costs` for any of the organization's
Spaces since the period began. Admission locks the organization, so concurrent requests on several
API instances cannot overspend it. A spent allowance stops advertising included voice, which
leaves device speech and personal setup in place.

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
zero requires evidence of no charge. The confirmed cost replaces the reservation in the allowance.
Repeated identical confirmation is idempotent; a changed cost, source or reference is rejected. Tenant SQL cannot edit or delete cost evidence; scoped accounting operations use an explicit system context. Preserve
source exports in the operator's private financial system. No invoice API/reconciliation worker
is installed here: the operator must schedule or perform this evidence import. Alert on old
pending/unresolved rows; they intentionally reduce available allowance until resolved.

A completed request whose settlement write fails still returns its audio or transcript. The error
log identifies `speechCostId`, provider, operation and provider request ID (when available), so an
operator can locate its pending row without transcript, audio or credentials in the log.
