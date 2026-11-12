# Bot email addresses

Give each bot its own address, such as `scout@bots.example.com`. Every email sent to it is saved
to the bot's inbox, which the bot reads when it needs to, for example to pick up the code when it
signs up for a service. Your own mail to it starts the bot, and mail can start its
[routines](./routines.md). Bots can also [send email](#sending) from their address. This is
optional and off until you set it up.

You need a domain (or subdomain) that receives mail for every name on it, and something that
hands each message to Rakazo. Rakazo does not run a mail server itself: any mail relay that can
make an HTTPS request works.

## Configure Rakazo

Set both on the API, and `INBOUND_EMAIL_DOMAIN` on the worker too, so each bot knows its address.
Then restart them:

```bash
INBOUND_EMAIL_DOMAIN=bots.example.com
INBOUND_EMAIL_SECRET=$(openssl rand -base64 32)
```

Use a domain that nothing else receives mail on, and set exactly the domain the relay receives
mail for. Once it is set, a bot's owner can get it an address under its name in the bot's
settings, by asking the bot in chat, or when adding an **Email** trigger to a routine. Claimed
addresses are listed in the Vault. Names are lowercase, never change, and are never given to
another bot, even after the bot is deleted.

## Hand mail to Rakazo

The relay posts each message, unchanged, once per recipient:

```http
POST /api/v1/email/inbound?to=<recipient address>
Authorization: Bearer <INBOUND_EMAIL_SECRET>
Content-Type: message/rfc822

<the raw message>
```

Rakazo answers `200` for every message it accepted, including mail it drops, so the relay never
retries or bounces it. `401` means the secret is wrong and `413` means the message is over 25 MB.
Treat any other error as temporary and retry.

### Cloudflare Email Routing

Cloudflare receives mail for every name only on a domain's apex, such as `example-bots.com`, not
on a subdomain, so set `INBOUND_EMAIL_DOMAIN=example-bots.com` too. Add the domain to Cloudflare,
turn on **Email Routing**, then deploy this Worker
with `RAKAZO_URL` set to your public URL and `INBOUND_EMAIL_SECRET` stored as a secret:

```js
export default {
  async email(message, env) {
    const url = new URL("/api/v1/email/inbound", env.RAKAZO_URL);
    url.searchParams.set("to", message.to);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.INBOUND_EMAIL_SECRET}`,
        "content-type": "message/rfc822",
      },
      // Streamed as received; the Worker never holds the whole message.
      body: message.raw,
    });
    if (response.status === 413) message.setReject("Message too large");
    else if (!response.ok) throw new Error(`Rakazo answered ${response.status}`);
  },
};
```

In **Email Routing → Routing rules**, set the **Catch-all** rule to **Send to a Worker** and pick
this Worker.

### Postfix

On a host that already runs Postfix with an MX record for the domain, add a pipe transport. In
`master.cf`:

```text
rakazo  unix  -  n  n  -  -  pipe
  flags=Rq user=nobody argv=/usr/local/bin/rakazo-inbound-email ${recipient}
```

In `main.cf`, add the domain to `relay_domains` and a transport map, keeping any values already
there, and hand the transport one recipient at a time:

```text
relay_domains = <existing domains> bots.example.com
transport_maps = <existing maps> hash:/etc/postfix/transport
rakazo_destination_recipient_limit = 1
```

Add `bots.example.com rakazo:` to `/etc/postfix/transport` and run `postmap` on it. Save the same
`INBOUND_EMAIL_SECRET` where the pipe's user can read it and no one else can:

```sh
sudo install -d -m 755 /etc/rakazo
printf %s "$INBOUND_EMAIL_SECRET" | sudo install -m 400 -o nobody /dev/stdin /etc/rakazo/inbound-email-secret
```

Save the script below as
`/usr/local/bin/rakazo-inbound-email`, make it executable (`chmod 755`), and run `postfix reload`
once the configuration is in place. The script needs `curl` and `jq`. It bounces a message that is too large and exits with 75 for anything else that fails, so Postfix
keeps the message and tries again:

```sh
#!/bin/sh
recipient=$(printf %s "$1" | jq -sRr @uri) && [ -n "$recipient" ] || exit 75
status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 \
  -H "Authorization: Bearer $(cat /etc/rakazo/inbound-email-secret)" \
  -H "Content-Type: message/rfc822" \
  --data-binary @- \
  "https://rakazo.example.com/api/v1/email/inbound?to=$recipient")
case "$status" in
  2??) exit 0 ;;
  413) exit 69 ;;
  *) exit 75 ;;
esac
```

## The inbox

Each message is saved once, however often the relay delivers it, until the bot deletes it or the
bot itself is deleted. Deleting mail follows the owner's [approval](./approvals.md) settings, and
files kept from that mail stay in the bot's files. A bot
saves at most 500 messages a day that start nothing; past that, such mail is dropped until the
day's count falls, while mail that starts the bot or a routine is always saved. The bot
reads its inbox only in its owner's own chat, routines and mail, never in a group chat or a shared
channel, and what it reads counts as outside data.

## Sending

Bots send through a separate TLS SMTP connection, configured on both API and worker:

```bash
BOT_EMAIL_SMTP_URL=smtps://username:password@smtp.example.com:465
```

The relay must accept and DKIM-sign mail from `INBOUND_EMAIL_DOMAIN`. Keep its credentials
separate from account email. Leaving this unset disables bot sending; it never falls back to
`EMAIL_PROVIDER` or `SMTP_URL`. Existing receiving and account email settings keep working.
The bot supplies its own From and Reply-To address, so replies return to its inbox.

Each account starts with ten recipient deliveries per rolling 24 hours, shared by every bot
and Space. CC recipients and failed delivery attempts count too. Deleting mail or a bot never
resets usage. Reservations from before recipient accounting, including overlapping older
workers, count as ten deliveries until they leave the rolling window because their recipient
counts are unknown. An account must have a verified email and be active. By default bots can
send only to that verified owner address, including scheduled reports.
When upgrading, drain previous-release workers before enabling bot sending; they still enforce
their previous policy until they finish.

An operator can enable replies to authenticated incoming senders and raise the allowance using
the API container's CLI:

```bash
node dist/cli/bot-email-policy.js status owner@example.test
node dist/cli/bot-email-policy.js limit owner@example.test 20
node dist/cli/bot-email-policy.js replies owner@example.test on
node dist/cli/bot-email-policy.js allow owner@example.test reports@example.test
node dist/cli/bot-email-policy.js deny owner@example.test reports@example.test
node dist/cli/bot-email-policy.js limit owner@example.test 0
```

`status` lists the approved addresses; mutating commands print only their count.
Zero pauses all bot sending. Changes are recorded in the security audit log, including whether
anything changed and the canonical recipient for `allow` and `deny`. These recipient identifiers
remain in the protected database audit and follow its retention policy. No user or bot tool
can raise the allowance or enable external replies. This is an account-wide operator policy;
changes are not copied into organization audit logs, where unrelated organization admins could
read them. Reply access permits only the authenticated From address of an incoming message
received in the last 30 days, identified by `inReplyTo`.
It does not permit arbitrary recipients, reply-all, or recipients from a Reply-To header.
Use `allow` only for recipients whose consent has been reviewed, such as a report destination
that differs from the account login. `deny` removes that exception.
The bot's usual action approvals still apply inside these limits, and known secrets are removed.

Before enabling external replies on a hosted deployment, configure the sending service's hard
bounce and complaint suppression and operational alerts. Review the workflow and recipient
consent; a paid subscription alone is not authorization for external sending.

### Monitoring operator changes

The CLI commits its security event in the same transaction as the policy change. Its output
from `docker exec` is not part of the API process's structured log stream. Monitor committed
`bot_email.policy.changed` rows in `security_events` directly, using an operator database
connection. For example:

```sql
SELECT id, "createdAt", "userId", metadata
FROM security_events
WHERE type = 'bot_email.policy.changed'
  AND "createdAt" > NOW() - INTERVAL '15 minutes'
ORDER BY "createdAt", id;
```

Configure database-backed alerts on newly observed event IDs, including permission grants and
allowance increases; API log-sink alerts alone do not cover this CLI. Treat `metadata.recipient`
as account data and restrict access to operators. See [security events](./self-host-observability.md#security-events)
for database access and retention.

## Who can start work

Rakazo checks each message's DKIM signature itself. A message is verified only when it is signed
by the domain in its **From** address and that signature covers its **To** and **Cc**. Many
services sign with another domain, so their mail is saved as unverified: the bot can still read
it but is told its sender could be forged. Signed mail that doesn't name the bot in **To** or
**Cc**, such as a BCC or a message replayed from someone else's inbox, is saved as unverified
too, without its files.

Microsoft 365 never signs **To** or **Cc**, so on its own its signature can't show the message
was meant for the bot: anyone the sender wrote to could resend it. Such mail is verified only
when it is signed by the From domain with its **Date**, is less than a day old, and your relay
saw it arrive straight from a server that domain's SPF record allows. Rakazo trusts that last
result only from the relay you name by its ARC signing domain, and checks the relay's ARC seal
itself:

```bash
INBOUND_EMAIL_RELAY_ARC_DOMAIN=cloudflare-email.net   # Cloudflare Email Routing
```

Without it, or when the relay doesn't seal its results (Postfix does not by default), mail whose
signature leaves out **To** stays unverified. So does such mail that was forwarded on its way.

Only verified mail that names the bot in **To** or **Cc** starts anything, and never an automatic
reply or mailing-list mail. The owner's own mail sent **To** the bot starts it in its chat, once
the owner has confirmed their account's email address; mail that only copies the bot is saved. An
email trigger
starts its routine for the owner's own address, or for anyone at the owner's email domain when
the routine allows it. Mail that claims the owner's address but fails the check posts a
note in the bot's chat, at most once a day, without any of its content. That usually means the
owner's domain does not sign its own mail: Google Workspace and Microsoft 365 need DKIM turned on
for a custom domain. For Microsoft 365 it can also mean `INBOUND_EMAIL_RELAY_ARC_DOMAIN` is not
set.

A routine's mail reaches the bot as outside data, never as instructions. In the owner's own mail,
the bot follows what the owner asks but treats anything forwarded or quoted as data. Runs started
by mail follow the stricter [approval](./approvals.md) rules for outside events. Up to four
attachments of verified mail are kept, within the usual upload type and size limits; the bot sees
the names of any it could not keep, and of every file in unverified mail.
