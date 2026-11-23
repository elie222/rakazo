# Hosted Telegram operator runbook

Status: implemented and tested offline; hosted delivery is **not verified**. Keep the
self-hosted-only marketing restriction until the acceptance steps below pass on the hosted
deployment. This runbook does not authorize production changes.

## Ownership and configuration

The operator owns one deployment bot and its webhook. Every customer links their own account
and chosen Rakazo bot to that shared bot. Customers connect their model in Rakazo's existing
model connection settings using a supported subscription connection or API key; they do not
register a Telegram bot, supply its token, or configure infrastructure services. This does not
make an arbitrary consumer LLM subscription usable as an API connection. Existing model access
and billing gates still apply. Optional voice transcription needs a configured voice connection;
Telegram linking does not supply one.

An operator must create or select a bot through BotFather and securely obtain its token. Set
these values in the deployment's secret/configuration system, on **both API and worker**, and
restart those processes. Values below are placeholders, never real credentials:

```dotenv
API_URL=https://api.example.test
TELEGRAM_BOT_TOKEN=<deployment-bot-token>
TELEGRAM_WEBHOOK_SECRET_TOKEN=<random-webhook-secret>
MESSAGING_OPEN_SIGNUP=false
```

Use a cryptographically random webhook secret (for example, 32 random bytes encoded as hex).
The public linking destination is discovered from the authenticated `getMe` response when the
adapter initializes. No username setting is needed. Until identity lookup succeeds, no destination
is advertised. Opening messaging settings refreshes the authenticated destination and can recover
from a startup identity outage without an inbound message or restart. Failed refreshes hide the
previous address. A legacy SDK username override cannot change the displayed destination.

The standard Compose files forward these settings. Named bots additionally use
`TELEGRAM_BOT_TOKEN_SUPPORT` and `TELEGRAM_WEBHOOK_SECRET_TOKEN_SUPPORT`. Forward both through a
Compose override to API and worker as described in
[named settings](./self-host-configuration.md#settings-with-names-you-choose). The provider and route
for that mount are `telegram-support` and `/api/v1/messaging/webhook/telegram-support`.
Each token must identify a distinct bot.

## Register the webhook (operator action, not performed here)

Route public HTTPS requests to the API at `/api/v1/messaging/webhook/telegram`. Preserve
`X-Telegram-Bot-Api-Secret-Token` through the ingress. Do not put browser login middleware in
front of this endpoint. The adapter checks the shared secret before inbound work; Telegram
uses this header rather than a body HMAC signature. Keep the token and header out of access
logs, traces and tickets. API and worker must have the same credentials and access to the
existing shared database/jobs infrastructure. Only API receives inbound updates.

The receiving API preserves automatic transport selection: it uses a registered webhook and
otherwise may poll. An API URL, including localhost, does not prove that a webhook was registered.
Workers never poll. Register and verify the hosted webhook before starting multiple API instances;
do not run another poller or webhook consumer with the hosted bot token.

The following example registers the webhook without placing credentials in command arguments
or printing raw API responses. Run only in an authorized operator shell with the above variables
already supplied securely. When the optional public username is supplied, it checks that the
token belongs to that bot. It keeps pending updates, and reports sanitized success/failure. It changes the bot's webhook.

```sh
python3 - <<'PY'
import json
import os
import sys
import urllib.request

try:
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    secret = os.environ["TELEGRAM_WEBHOOK_SECRET_TOKEN"]
    username = os.environ.get("TELEGRAM_BOT_USERNAME", "").strip().removeprefix("@")
    origin = os.environ["API_URL"].rstrip("/")
    if not origin.startswith("https://") or not secret:
        raise ValueError()
    webhook = origin + "/api/v1/messaging/webhook/telegram"

    def call(method, payload):
        request = urllib.request.Request(
            "https://api.telegram.org/bot" + token + "/" + method,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
        if not result.get("ok"):
            raise ValueError()
        return result["result"]

    bot = call("getMe", {})
    if username and bot.get("username", "").lower() != username.lower():
        raise ValueError()
    if call("setWebhook", {
        "url": webhook,
        "secret_token": secret,
        "allowed_updates": ["message", "edited_message", "callback_query"],
        "drop_pending_updates": False,
    }) is not True:
        raise ValueError()
    info = call("getWebhookInfo", {})
    if info.get("url") != webhook:
        raise ValueError()
    print("Webhook registered; complete delivery acceptance checks next.")
except Exception:
    print("Webhook setup failed; inspect securely without publishing raw responses.", file=sys.stderr)
    sys.exit(1)
PY
```

Restart every API instance after registration succeeds, so automatic transport selection runs
again and any polling receiver from the initial startup stops. Verify the restarted API uses the
registered webhook before adding more API instances. Workers do not receive updates and need no
second restart unless their configuration changed.

For a named mount, substitute that mount's three environment names and webhook path in the
example. Registration replaces any webhook previously registered for the same bot. Schedule
that change deliberately. Do not use `drop_pending_updates=true` for routine setup or recovery.
`getWebhookInfo` checks registration; a stored `last_error_message` may predate this setup and
is not proof of a failed registration. Review delivery-error timestamps privately and complete
the live acceptance checks; registration alone cannot prove linking or agent replies work. See the [Telegram Bot API](https://core.telegram.org/bots/api#setwebhook)
for registration parameters.

## Customer flow and hosted acceptance

Use dedicated test accounts and synthetic conversations. Do not publish their identifiers,
link codes, message contents, or unredacted screenshots.

1. Verify the bot's identity and HTTPS ingress; verify an unsigned request and one with an
   incorrect secret are refused without creating an identity or run.
2. Connect a supported model in Rakazo. In **Settings → Messaging**, select an owned bot,
   choose Telegram, and verify the destination discovered from the authenticated bot identity appears. Open that
   bot in Telegram, press **Start**, then send only the displayed code in the private chat
   within ten minutes. `/start` by itself does not link an account.
3. Confirm the link appears in Rakazo and the confirmation returns to the same private chat.
   Send a synthetic prompt; verify one run in the selected bot's Space and a reply in Telegram.
   Confirm the existing billing/model-access gates still refuse unavailable access.
4. Repeat with a second Rakazo account and a different Telegram sender using the **same**
   deployment bot. Verify their runs, credentials, memory, approvals and replies stay separate.
   A code selects its issuer's bot; possession of the shared deployment bot is not account access.
5. Verify a spent or expired code cannot link a different sender, and issuing a fresh code
   invalidates the old one. Never paste a code into a group. Verify an address already owned
   by another account cannot be reassigned with a code.
6. In a controlled test environment, replay a delivered update and retry one after an induced
   transient processing failure. Verify no duplicate run or confirmation is recorded and
   failed processing can recover. Check pending delivery drains after recovery.
7. Verify unlinking stops delivery. In a synthetic group, verify each linked member gets their
   own consent request and no personal relay starts before approval; test decline, leave and
   removal. Broadcast channels are unsupported. For full group delivery, disable privacy mode
   in BotFather and re-add the bot, or make it an admin. See Telegram's
   [privacy-mode guidance](https://core.telegram.org/bots/features#privacy-mode).
8. Check linking status on web, Electron and mobile. Clients use the same authenticated API;
   no customer infrastructure credential is part of this flow.

Record the deployment version, sanitized outcomes and unresolved failures privately. Only after
these checks pass should a separate marketing change remove the hosted restriction.

## Recovery and limits

If inbound is silent, inspect `getWebhookInfo` privately for endpoint, backlog and recent error,
then check ingress forwarding, matching secrets, and API startup. Re-register the correct
endpoint/secret after rotation; synchronize API and worker credentials first, then restart all API
instances after registration. Never log raw
requests or credential-bearing Telegram request URLs. If the bot token is compromised, revoke
it through BotFather and replace it in both processes before re-registering the webhook.

Inbound retries use SDK deduplication plus durable per-message nonces; link consumption and
confirmation recording share a transaction. Delivery uses the existing durable outbox and
backup jobs. Telegram sends have no provider idempotency key: a process crash after Telegram
accepts a send but before its handle is persisted can produce a duplicate reply. Do not claim
exactly-once external delivery. Blocking the bot is a permanent send refusal; customers must
unblock it before expecting replies. Long replies are split using the existing formatting-aware
limits. No production Telegram calls were made for this implementation.
