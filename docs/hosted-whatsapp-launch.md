# Hosted WhatsApp launch decision

Reviewed against official sources on **2026-11-17**. This is an operator runbook, not a hosted
availability announcement. No production accounts, credentials, purchases or provider approvals
were inspected or changed. Target launch countries have not been supplied.

## Decision

Keep the existing direct Cloud API adapter for a **conditional, user-initiated DM pilot** on one
operator-owned business number. Users link their existing Rakazo account and reasoning connection;
they do not register a business or supply messaging credentials. Do not enable hosted WhatsApp
until the gates below are satisfied. Keep the current marketing restriction.

Treat Rakazo as a general-purpose assistant for launch planning, including when users bring their
own model connection. Calling it a productivity tool or buying transport through a gateway does
not establish eligibility. A global launch is blocked; a restricted pilot is a candidate, not an
approved deployment. Self-hosting remains optional and subject to the same upstream rules.

## Eligibility and messaging rules

[Meta's AI Provider policy and rates](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers)
permits general-purpose assistants only where Meta is legally required to allow them. Its current
list covers the EEA (including Italy), Brazil and Türkiye. US, Canada, UK, Israel, India and
Switzerland are absent: treat these as blocked pending a changed official policy, not as markets a
gateway can unlock. The policy uses recipient markets/dialing codes, not the server's location.
For AI service messages, Meta currently charges in Brazil; EEA charges ended May 13, 2026, and
Türkiye has no charge from October 15, 2026. Recheck this list and the linked rate card before launch.

The [Business Messaging Policy](https://business.whatsapp.com/policy) requires opt-in for subsequent
contact, respect for opt-out, an accurate business profile, privacy notices, and a clear escalation
path for automated responses. A user's message opens/resets a 24-hour service window. Free-form
replies are allowed within it; outside it only approved templates may be sent. Templates can be
rejected, paused or withdrawn. A link code is not proof of consent to every future reminder.

For reminders: obtain explicit purpose-specific consent, keep evidence and opt-out behavior, and
have Meta approve the actual template and category. A requested reminder may qualify as utility;
arbitrary assistant output must not be stuffed into template variables to bypass the service
window. A sent template does not itself supply a new user message. Template approval does not
waive AI eligibility. The proposed pilot excludes proactive reminders; a later template delivery
feature needs its own scoped implementation and tests.

The full [platform terms](https://www.whatsapp.com/legal/business-solution-terms/) redirected to a
login/block page during this review. The public AI policy above explicitly describes the
restriction, but the operator must review the current full terms in its own account before enabling.

## Transport options

| Path                    | Demonstrated benefit                                                                                                     | What remains                                                                                    | Decision                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Existing direct adapter | Already mounted by complete server credentials; linking, text/media transport, signed webhooks and status handling exist | Business/number onboarding, eligibility, billing, live acceptance; no product template delivery | Retain for eligible DM pilot                                         |
| Photon WhatsApp         | Advertises managed Cloud API transport, templates and a unified API                                                      | Same Meta business/verification/policy; new integration and contract validation needed          | No adapter now                                                       |
| Twilio WhatsApp         | Established gateway with documented console Self Sign-up                                                                 | Same upstream requirements, additional fees and a new adapter                                   | Contingency if a specific onboarding/operations failure justifies it |

[Photon's WhatsApp page](https://photon.codes/platform/whatsapp) says it is an official Meta Business
Technology Provider using Cloud API, connects the business account and number, and leaves
verification and policy configuration in Meta. Its
[2.0 announcement](https://photon.codes/blog/introducing-photon-2.0) introduces a unified API, not a
policy exemption. That may simplify transport operations, but does not demonstrate resolution of
Rakazo's eligibility or registration blockers. The existing Rakazo Photon integration is for
iMessage, not evidence of working WhatsApp support; leave that separate adapter untouched.

[Twilio Self Sign-up](https://www.twilio.com/docs/whatsapp/self-sign-up) lets direct customers register
through its console. It requires an upgraded account, a Meta business portfolio with administrator
access, and a compatible number that can receive the ownership OTP. Its guide requires business
verification before production. Onboarding customer-owned businesses instead requires its Tech
Provider program/integration. For the proposed Rakazo-owned number, this is operator setup once,
not signup work for every Rakazo user. Do not register with Twilio and expect its sender credentials
to work with the direct adapter.

## Cost approval still required

Direct transport avoids a gateway handling fee, not Meta fees or model inference cost. Reasoning
credits and the user's reasoning connection are separate from messaging billing.

[Twilio's current fee explanation](https://help.twilio.com/articles/360037672734-How-Much-Does-it-Cost-to-Send)
reports an October 1, 2026 change: paid templates and service messages after an initial monthly free
allowance for ordinary businesses, plus distinct AI Provider service-message charges passed through.
Do not apply ordinary-business allowances to Rakazo without confirmation. Its
[pricing page](https://www.twilio.com/en-us/whatsapp/pricing) lists $0.005 inbound or outbound handling,
but also retains contradictory older statements about free utility messages. Use the current
account rate card and AI classification for budgeting, not a blanket “24-hour replies are free” claim.

[Photon pricing](https://photon.codes/pricing) places WhatsApp under Business, alongside a
$250/line/month iMessage price and an “Included” label. It does not establish WhatsApp's standalone
price or treatment of Meta AI fees. Do not budget zero or purchase an iMessage line on that evidence.

Meta's main pricing page was login-gated in this review and its AI rate-table download was not
exposed as a usable link by the fetch. The exact current Brazil AI rate, billing currency, template
rates by destination/category, gateway pass-through terms (if selected), and spend authorization
remain operator blockers. Record those in private operations records, not this public repository.
Long replies split into multiple transport messages, so budget per delivered part, not per prompt.

## Exact direct operator setup

Perform only after the eligibility and spend decisions; none of these external changes were made.

1. Record the intended recipient markets and the account's AI Provider treatment. Review current
   terms, business verification, account restrictions, support escalation and privacy/consent flow.
   Start with one eligible market. If eligibility cannot be established, leave all four transport
   settings unset; do not describe the integration as available on hosted Rakazo.
2. In the operator's Meta business portfolio, create/select the business app and WhatsApp assets.
   [Current account documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/whatsapp-business-accounts)
   distinguishes the WhatsApp account holding the number and the Messaging account holding templates
   and billing; older dashboards call these WABA assets. Configure the real business profile,
   approved display name and payment method; finish required verification. Users linking Rakazo
   accounts are not being onboarded as separate businesses in this design.
3. Use a dedicated operator-owned number, not personal-account automation. Add it, verify ownership
   by SMS/voice, then register it with `POST /<PHONE_NUMBER_ID>/register` using
   `{"messaging_product":"whatsapp","pin":"<SIX_DIGIT_PIN>"}`. Secure the two-step PIN outside
   source control. [Registration reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration).
   If already registered elsewhere, stop and follow the official migration/coexistence path; do not
   delete or migrate an existing number as part of this task.
4. Generate a production system-user token for the operator's own assets, not the temporary API
   Setup token. Assign the app and required account assets. Follow the current permissions flow
   (`business_management`, `whatsapp_business_management`, `whatsapp_business_messaging`), granting
   only the assets needed. [Access token guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens).
   Record token expiry/rotation privately. Customer-owned asset onboarding would instead require a
   separate Embedded Signup/Tech Provider design; it is outside this pilot.
5. Supply the following to **both API and worker** through the deployment secret mechanism. Values
   below are deliberately fake. `PHONE_NUMBER_ID` is the API object ID, not the visible phone number;
   the app secret and webhook verification string are different secrets.

   ```dotenv
   WHATSAPP_ACCESS_TOKEN=FAKE_SYSTEM_USER_ACCESS_TOKEN
   WHATSAPP_PHONE_NUMBER_ID=FAKE_PHONE_NUMBER_OBJECT_ID
   WHATSAPP_APP_SECRET=FAKE_META_APP_SECRET
   WHATSAPP_VERIFY_TOKEN=FAKE_RANDOM_WEBHOOK_VERIFY_TOKEN
   ```

6. Set the app callback to `https://api.example.test/api/v1/messaging/webhook/whatsapp`, replacing only
   the fake public origin. Allow GET verification and POST events with valid public TLS. Set the
   verification token to the same server value, subscribe to `messages`, and ensure the app is
   subscribed to the correct business account (the `subscribed_apps` edge in existing account APIs).
   Confirm receipt from the real number, not just the dashboard's sample event. Preserve the exact
   request body and `X-Hub-Signature-256` through the proxy; the app secret authenticates POSTs.
   [Endpoint reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint),
   [webhook permissions and fields](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview),
   [account API reference](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/).
7. Keep `MESSAGING_OPEN_SIGNUP` unset/false. Use an existing Rakazo account with a configured reasoning
   connection, then Settings → Messaging → choose bot → WhatsApp → send the temporary link code to
   the operator's number. No new messaging signup or model-credit behavior is introduced here.

## Code audit and release gates

The direct implementation is
[`whatsapp-messaging.ts`](../packages/adapters/src/providers/messaging/whatsapp/whatsapp-messaging.ts),
using pinned `@chat-adapter/whatsapp` 4.44.0 (default Graph version v25.0). It mounts only with all
four credentials, supports DMs, rejects groups, renders/splits outbound text, and translates delivery
status webhooks. The shared surface verifies through the SDK before forwarding statuses; it drains
inbound processing before acknowledging. Synchronous error 131047 is permanent, and asynchronous
`failed` callbacks mark delivery failed. No template auto-send or service-window persistence exists
in Rakazo. The SDK has `sendTemplate`, but the product delivery contract does not expose it.

Offline tests cover configuration isolation, formatting/splitting and permanent-error classification;
the new provider test exercises the real SDK's GET verification, forged/missing POST signatures,
signed inbound linking text and signed asynchronous service-window failure without network access.
They establish transport behavior, not business eligibility or production delivery.

Before hosted enablement, the operator must record successful acceptance on an authorized test
account/number: public GET verification; real signed inbound message; account/bot linking; a reply
reaching the same user; long replies and delivery callbacks; expired-window failure; opt-out/unlink;
and account isolation between two users. Verify identity continuity for username/BSUID-only senders
as well as phone-number senders; the pinned SDK supports these identifiers, but hosted acceptance
has not been performed. Verify the pinned Graph version remains supported.

The current adapter has no deployment-specific recipient-market gate. A general hosted deployment
must not be enabled merely because a number registers: first establish an enforceable restricted
pilot audience, including rejecting unsupported senders before assistant execution and send, with
reviewed handling of BSUID-only identities. That enforcement is a separate clearly specified change
once target markets/account eligibility are selected; a public shared number alone is insufficient.
Do not hardcode a guessed permanent country allowlist in generic contracts.

Unresolved launch gates: selected target markets and enforceable audience restrictions; current full
terms/account eligibility; verified business and registered number; actual rate card and spend
approval; production token/secret/webhook provisioning; consent and escalation; authorized live
acceptance. Proactive reminders additionally require approved templates and product delivery support.
No gateway has demonstrated that it removes these gates. Keep hosted availability unannounced.
