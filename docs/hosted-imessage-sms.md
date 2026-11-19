# Hosted iMessage/SMS operator runbook

Research checked 2026-11-17 against official public documentation and the installed adapters.
No hosted account, line, delivery, billing arrangement, or production configuration was verified.
All configuration below is illustrative. Keep homepage self-hosted labels until the hosted
acceptance checks below have actually passed. Model credits and live calls are separate work.

## Recommendation

For a small hosted iMessage/SMS pilot, use one operator-owned dedicated inbound-first Sendblue
line and the existing adapter. Users text first, link their own Rakazo accounts, and supply a
reasoning model connection in their Space. No messaging vendor credentials belong in user setup.
This is an implementation-based recommendation, conditional on operator approval and live checks.

Photon helps: it supplies managed Apple messaging infrastructure, so users need no Mac. Stable
shared lines suit a low-cost iMessage text pilot; dedicated lines suit a consistent public number.
It does not unlock all Photon 2.0 channels in Rakazo. Do not replace the working adapter just to
obtain the newer product's advertised channel list.

## API generation and current support

Rakazo pins `@photon-ai/chat-adapter-imessage@3.2.0`, backed by `@spectrum-ts/core` and
`@spectrum-ts/imessage@10.0.0`. It dynamically loads Stable Spectrum using project ID/secret,
legacy `imessage:<chatGuid>~<line>` threads and `X-Spectrum-*` signed events. Supply credentials
for this Stable API; the newer API contract is not implemented by this adapter.

The [legacy integration guide](https://photon.codes/docs/integrations/chat-sdk) marks this package
retired. The [2.0 announcement](https://photon.codes/blog/introducing-photon-2.0) describes a new
Users/Spaces/Messages API. [Beta API documentation](https://photon.codes/docs/beta/api-reference)
uses bearer project keys under `/v1/projects/{projectId}`, explicitly recommends Stable for
production, and warns of incomplete feature parity. Migrating requires a separate adapter change,
event/credential translation and a plan for existing stored thread IDs, not a package rename.

| Capability                     | Existing Photon connection                                                  | Existing Sendblue connection                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Direct text and typing         | Enabled                                                                     | Enabled                                                                                                          |
| Groups                         | Explicitly disabled, even on paid projects                                  | Personal group linking enabled; actual plan must permit replies                                                  |
| SMS/RCS                        | No separate adapter/channel or transport reporting; fallback unverified     | Inbound iMessage/SMS/RCS allowed and transport reported; ordinary outbound sends let the service choose fallback |
| Incoming photo/file/voice memo | SDK exposes metadata but no `url` or `fetchData`; bytes never reach the bot | Adapter exposes media URL and lazy download; still requires live media checks                                    |
| Outgoing files                 | Generic file posting delegated to SDK; not live verified                    | Generic file posting delegated to SDK; not live verified                                                         |
| Native outgoing voice notes    | SDK has `sendVoice`, wrapper does not expose it                             | Provider supports `.caf` voice memos; generic file send is not an audio conversion pipeline                      |
| Delivery status                | No `peekStatuses` mapping; accepted send is not delivery evidence           | Callback status mapping present; validate callback authentication                                                |

Photon [Stable webhook payloads](https://photon.codes/docs/webhooks/events) contain attachment IDs
and metadata, not download URLs or bytes; out-of-band `getAttachment(id, space.phone)` retrieval is
required. Rakazo's wrapper does not expose that retrieval. Do not advertise media ingestion or
voice-note understanding on this connection. Fixing it safely needs explicit SDK byte access and
tests for line routing, size bounds and deleted attachments.

Sendblue [sending documentation](https://docs.sendblue.com/getting-started/sending-messages) permits
ordinary fallback, lists 100 MB maximum iMessage files (20 MB recommended) and 5 MB SMS files, and
documents `.caf` voice memos. Inline replies and App Cards have different fallback restrictions;
Rakazo does not gain those features from ordinary text posting.

## Plans, capacity and spend evidence

[Photon pricing](https://photon.codes/pricing) currently lists Free (10 users), Pro ($25/month,
100 users), both with managed shared numbers and no groups. The shared pool assigns a fresh
number per user rather than a single public project number. Business lists $250/line/month,
dedicated project numbers, groups and 50 new outbound contacts/line/day. Enterprise pricing is
custom. SMS/RCS fallback is listed as included. Unlimited daily traffic/users is qualified by
Auto Scale, described as automatic credit additions. These are published plan claims, not a
verified all-in spend ceiling or permission to enable automatic purchases.

Photon's [deliverability guidance](https://photon.codes/docs/best-practices/imessage-deliverability)
also specifies 5,000 outbound messages/server/day and 50 new conversations/line/day. It recommends
inbound-first conversations and distributing new contacts to avoid bursts. Its
[Stable API limit](https://photon.codes/docs/api-reference/rate-limit) is five requests/second/project.
Do not interpret the pricing word “unlimited” as unlimited throughput. Fallback remains subject to
carrier filtering and compliance.

Sendblue's [official overview](https://docs.sendblue.com/llms.txt) quotes $100/line/month for the
inbound-first AI Agent plan; outbound plans require a quote. Its
[limits](https://docs.sendblue.com/limits/) list 1,000 inbound contacts/line/day, replies within
24 hours, 200 follow-up contacts/day after that window, and a 10-message/second line acceptance
limit. AI Agent numbers may reply to groups they join but cannot create new groups. The page also
states a 150-consecutive-outbound safeguard. Rakazo already holds direct sends below that cap.
Confirm current plan entitlements and total charges, fallback destinations, taxes, media charges,
carrier registration and overages before enabling service; public evidence here does not establish
a complete per-message tariff. No purchase or vendor contact was made.

## Operator configuration

Choose one connection initially. Store real values in the deployment secret store, never in Git,
browser configuration or support logs. Set the chosen credentials on both API and worker.

For the recommended dedicated line:

```dotenv
API_URL=https://api.example.test
MESSAGING_OPEN_SIGNUP=false
SENDBLUE_API_KEY_ID=example-key-id
SENDBLUE_API_SECRET=example-api-secret
SENDBLUE_SIGNING_SECRET=example-webhook-secret
SENDBLUE_PHONE_NUMBER=+15550009999
```

An authorized operator must provision an inbound-first line, confirm SMS/MMS relay and any
required carrier registration, then register the **receive** webhook at
`https://api.example.test/api/v1/messaging/webhook/sendblue`. Configure its secret to match
`SENDBLUE_SIGNING_SECRET`. The adapter expects `sb-signing-secret` over HTTPS; this is a static
secret header, not a body HMAC. Ensure status callbacks carry the same secret too. Rakazo sets
`status_callback` from HTTPS `API_URL`. [Webhook management](https://docs.sendblue.com/getting-started/webhooks)
supports per-webhook and global secrets; use the dashboard to avoid replacing unrelated hooks.
Never log webhook bodies or authentication headers.

For the Photon Stable alternative:

```dotenv
MESSAGING_OPEN_SIGNUP=false
PHOTON_PROJECT_ID=example-stable-project
PHOTON_PROJECT_SECRET=example-project-secret
PHOTON_WEBHOOK_SECRET=example-signing-secret
```

Create/use a **Stable** project, choose its shared/dedicated entitlement, and register
`https://api.example.test/api/v1/messaging/webhook/photon` in the Stable dashboard's Webhook tab.
Store the one-time signing secret as `PHOTON_WEBHOOK_SECRET` before receiving events.
[Stable management](https://photon.codes/docs/webhooks/managing-webhooks) uses
`https://spectrum.photon.codes/projects/{projectId}/webhooks/` with Basic project ID/secret auth.
Use public HTTPS with no redirects; allow required outbound Spectrum HTTPS/gRPC connectivity.
Each registered URL receives all project events: never mirror production events into development.

For another independent project, use `PHOTON_PROJECT_ID_EXAMPLE`,
`PHOTON_PROJECT_SECRET_EXAMPLE`, `PHOTON_WEBHOOK_SECRET_EXAMPLE` and route
`/api/v1/messaging/webhook/photon-example`. Keep provider names stable: they key stored identities.
When using Compose, forward all three suffixed variables to both `api` and `worker` in an
override file, following [settings with names you choose](self-host-configuration.md#settings-with-names-you-choose).
The base Compose files forward only the unsuffixed names.
Duplicate project mounts are skipped. A dedicated line suffix is retained in reply threads.
Shared assignments need an operator-supplied way for the user to discover their number; Rakazo
does not provision or display a per-user shared assignment automatically. Do not hardcode one
shared number for everyone. A dedicated Sendblue line already publishes its address in settings.

Leaving all messaging credentials unset keeps self-hosting independent of these services. For a
private Stable installation without public ingress, omit the webhook secret and let the receiving
API consume the existing outbound stream; send-only workers do not consume it. Do not use this as
the hosted reliability configuration.

## Linking, isolation and recovery

Keep open signup off. A user configures a model connection, chooses their bot in Messaging
settings, and texts the single-use code within ten minutes. The backend binds verified sender
address plus mounted provider to that code's user, Space and bot; an address owned by another
account cannot be taken over with a new code. Ordinary unlinked messages stay silent. Web,
Electron and mobile use this same backend route; no native device changes are needed.

A provider project/line is transport infrastructure, not a Rakazo tenant. Each linked identity
resolves its own Space's model credentials and context. Separate provider projects and signing
secrets isolate mounts; they do not prove isolation between users sharing one mount. Treat phone
number recycling, lost phones and pasted linking codes as account-support risks. No automatic
number ownership re-verification was added here.

Use signed webhooks for hosted Photon. [Delivery policy](https://photon.codes/docs/webhooks/delivery)
provides six attempts by default, 30-second attempt timeouts and bounded backoff, with no dead-letter
queue. `2xx` stops retries; `5xx`, `408`, `429` retry; most other `4xx` are terminal. Rakazo drains
inbound processing before acknowledgement, returns `500` on sink failure, and clears failed Chat
dedupe markers. Durable downstream message nonces handle replay across processes. The stream
alternative rearms every minute and retries handler failures three times in memory; a crash or
long outage can still lose an event. Neither mode establishes zero-loss delivery. After an outage,
inspect provider delivery failures and reconcile through an authorized, idempotent recovery flow;
no automatic reconciliation or replay tool was introduced.

## Remaining acceptance checks before advertising hosted support

1. Approve the selected plan, budget and billing controls without enabling unapproved Auto Scale.
   Confirm Stable project availability if choosing Photon; retirement may affect new provisioning.
2. Configure staging secrets and public ingress through normal operator deployment. Confirm invalid
   signatures are refused and receive/status callbacks authenticate without exposing their payloads.
3. Link two test accounts to different bots and model connections on the same mounted provider.
   Exchange distinct fake messages; verify histories, replies, approvals and model use never cross.
   Repeat one sender across two named projects if those will be offered.
4. From opted-in test phones, verify customer-first iMessage and Android SMS roundtrips, including
   fallback and delivery status. Confirm actual sender identity after restart. Do not infer SMS
   readiness from iMessage success or API acceptance.
5. Exercise selected-plan media and an incoming audio memo, and a permitted existing iMessage
   group on Sendblue. SMS remains direct-only in Rakazo; Photon groups remain disabled. Do not
   promise Photon media or native voice-note output with the current wrapper.
6. Fail an inbound request before storage, redeliver, restart the API, and check exactly one stored
   inbound/run. Simulate an outage longer than the provider retry budget and document recovery.
   Outbound network timeouts can still duplicate a send where no provider idempotency key exists.
7. Record the verified plan/generation/channel matrix and recovery owner privately; only then
   change hosted claims. Routine web and desktop e2e remain CI-only.

Offline coverage verifies the legacy credential guard, signed/stale/forged delivery behavior,
failed-sink redelivery and dedupe, named-project secret/namespace isolation, pinned reply line,
Photon group exclusion and media limitations, plus Sendblue direct transport normalization. It
does not prove live delivery, carrier eligibility, tenant end-to-end operation or billing limits.
