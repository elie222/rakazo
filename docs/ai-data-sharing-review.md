# Mobile AI data sharing: release and review

## Scope

The mobile client obtains permission before uploading attachments, submitting messages,
starting routines, or sending voice content. Consent is stored per account, Space, recipient,
and disclosure version. Read-only disclosure/grant endpoints do not change provider execution.
Web, Electron, workers, helper model selection, and self-hosted server execution retain their
existing behavior. There are no gateway blocklists, provider-routing overrides, or external
metadata requests introduced by consent.

Permission includes background work explicitly started from mobile. Withdrawal applies to
new mobile actions; it does not cancel work already authorized. Stop runs and disable routines
using their existing controls. This flow is not a global data-access or run-revocation system.

## Release gates

- Confirm the review account's actual model, voice, memory, and cloud-agent configuration.
- Verify the selected providers' agreements, retention, deletion, and security safeguards
  support the policy's equal-or-greater-protection commitment. A privacy link alone is not proof.
- For OpenRouter or Vercel AI Gateway, verify actual downstream routing and provider agreements.
  Apple's cited rejection requires recipient disclosure and permission, not a blanket ban on
  these gateways. The disclosure names the gateway and explains onward routing. Confirm the
  review configuration is accurately described; do not claim Apple has preapproved this wording.
- Apply the additive consent-record migration and deploy the API before releasing the mobile
  client. Older servers without the disclosure endpoints cannot supply the new mobile flow;
  existing web/desktop clients and provider execution are unaffected.
- Self-hosters can set `PRIVACY_POLICY_URL` to their own absolute HTTP(S) policy URL. Otherwise
  the mobile flow links Rakazo's policy, which distinguishes hosted and self-hosted operators.
  Unknown custom providers have no invented provider-policy link.
- Deploy the website policy together with the mobile release.
- Review App Store Connect's App Privacy responses against deployed data flows. Specifically
  assess Photos or Videos for retained attachments and Audio Data for voice processing, using
  [Apple's collection definitions](https://developer.apple.com/app-store/app-privacy-details/).
- Run Expo compatibility checks and create a new signed iOS store build.

## Verification

Use synthetic content and a fresh review account on iPhone and an 11-inch iPad.

1. Send a first message. Confirm the alert names configured recipients, explains data and
   purposes, and opens the correct deployment policy.
2. Choose Not now. Confirm neither content upload nor message submission occurs and the draft
   remains available. Repeat with an attachment and with voice.
3. Choose Allow. Confirm the grant is saved before the mobile action proceeds.
4. Relaunch and verify the approved configuration does not prompt again.
5. Withdraw permission in Account → AI data sharing. Confirm the next mobile action prompts.
   Verify the screen explains that existing runs and routines are stopped separately.
6. Switch account, Space, server, or recipient endpoint. Confirm grants are not mixed.
7. Use desktop/web without mobile grants. Confirm messages, attachments, helpers, voice, memory,
   and routines retain their previous behavior.
8. Verify OpenRouter, Vercel AI Gateway, and custom/local providers remain selectable and keep
   their existing routing settings.
9. Capture a native iPad consent screenshot; there is no new desktop/web consent screen.

## App Review notes template

Replace bracketed fields after verification. Keep credentials in App Store Connect's private fields.

The mobile app requests permission before submitting content to configured AI services.
The alert names recipients, describes the data and purpose, and lets users decline.
To review: sign in, open [bot], enter a message, and tap Send. Choose Not now to verify that
submission is blocked, then send again and choose Allow. Voice requests permission separately.
Account → AI data sharing withdraws permission for new mobile actions; stop already-authorized
runs and disable routines using their controls. The policy is linked from the alert and Account.
Tested build: [version/build]. Attached: [native iPad screenshot].

## Reply template

We added a mobile permission flow before content is submitted for third-party AI processing.
It identifies configured recipients, describes the data and purpose, and lets users decline.
We updated the privacy policy and verified the review account's provider configuration and
protections. Please review build [version/build] using the steps in App Review Information.
