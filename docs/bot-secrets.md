# Reusable credentials

Ask a bot to connect an API using a key or password. It calls `request_secret` with a reference name and an HTTPS service origin. The protected card shows that origin before you save. Web, Electron and mobile use the same backend; the value is cleared from the input when submission starts and is omitted from messages, events and model input.

For example, the bot can request:

```json
{
  "label": "API key",
  "purpose": "api_key",
  "credential": {
    "name": "example_api",
    "origin": "https://api.example.test",
    "auth": { "type": "bearer" }
  }
}
```

The value is encrypted in Postgres `vault_credentials` using the deployment's `ENCRYPTION_KEY` (AES-256-GCM with record-bound authentication). Only the run's user can submit a reusable credential. It belongs to that user and survives later runs. By default it sits in the user's account vault, which every Space uses; a Space where the user keeps its own credentials has a separate vault that starts empty, so they have to be saved there again, and no other Space can read it. It is deleted when its owner is deleted, and a Space's own vault is also deleted with its Space. Names, destinations and authentication configuration are metadata; `list_secrets` returns those fields without values. No hosted credential service or prebuilt connector is required.

The bot uses `secret_request` to ask the backend to decrypt and inject the credential:

```json
{
  "name": "example_api",
  "url": "https://api.example.test/v1/items",
  "method": "GET"
}
```

Authentication supports Bearer tokens, a named header (`{"type":"header","name":"X-Api-Key"}`), and Basic authentication (`{"type":"basic","username":"api-user"}`). Basic uses the protected value as the password. Requests can send JSON, form-encoded or plain text bodies. The saved origin must match exactly, including port. Redirects and unsafe network destinations are rejected through the shared remote-request policy. Requests follow the existing action approval rules, have a 30-second deadline and a 1 MB response limit, and return at most 20,000 characters of redacted response content without response headers.

Self-hosted deployments can set `RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP=1` to also allow plain `http://` origins on private or loopback addresses (for example `http://nas.local:8123` or `http://localhost:3000`). It is off by default. Credentials sent this way are unencrypted: anything on that network, or any local service on that port, can read them. Enable it only on a network you trust. Link-local and cloud metadata addresses stay blocked, and public origins still require HTTPS.

Calling `request_secret` again with the same name and configuration returns the saved reference. Add `"replace": true` to show another protected card and replace its value. `forget_secret` with `{"name":"example_api"}` removes the stored value and prevents future use; an already-started request may finish. Remove a credential before changing its origin or authentication configuration. Each user can save up to 100 credentials per bot, with values limited to 16,384 characters.

The model has no tool for reading these values, and the backend removes direct and common encoded echoes from API responses. The approved service still receives the credential: redaction cannot defend against a malicious service deliberately transforming it. Choose a service you trust and use appropriately scoped credentials.

This boundary supports authenticated HTTP requests. Injecting a site credential into an AI-controlled shell command, file or arbitrary environment variable would let those commands read it, so those paths are not exposed. A value you deliberately want in the bot's own shell is a command variable, below. APIs needing request signing, OAuth refresh, multiple credentials or custom protocols should use a connector adapter. Existing `request_secret` calls with a `connectionId` retain their one-use connector-code flow.

## Command variables

When a value belongs in the bot's own shell rather than an HTTP header, save it as a command credential. The bot calls `request_secret` with `"auth": {"type":"command"}` and no origin:

```json
{
  "label": "NetBird setup key",
  "purpose": "api_key",
  "credential": {
    "name": "netbird-setup-key",
    "auth": { "type": "command" }
  }
}
```

The name is exported to that bot's shell commands as an environment variable: upper case with hyphens as underscores, so `netbird-setup-key` becomes `$NETBIRD_SETUP_KEY`. The environment is loaded fresh before every command, so a variable added, replaced or removed mid-run applies to the next command.

A command variable overrides a space variable exported under the same name. That is accepted and owner-controlled: you decide which environment a bot's commands run in, and a per-bot value is the narrower choice, so it wins over the space-wide value it shadows. Remove the space variable, or rename the command variable, if you want the space value instead.

If a saved bot command variable cannot be loaded, that variable is unset for the command, even when a space variable has the same name. Other variables remain available; no credential value or load error is exposed.

A command variable is redacted from command output in its plain, base64 and URL-encoded forms, and it cannot be used with `secret_request` or a `browser_act` login fill. Names that change how a shell or a common runtime starts, trust TLS, or run git or ssh helpers are reserved, as are names beginning with `LD_`, `DYLD_`, `RAKAZO_`, `GIT_CONFIG_` or `NPM_CONFIG_`. The reserved list is not exhaustive: it covers the well-known variables, and saving a reserved name is refused with the reason.

**The bot's shell reads this value.** A command variable is a convenience for the bot, not a boundary against it: the shell command the bot runs, and the code that command starts, can print, encode or send the value. Redaction stops it appearing in a result the model reads; it does not stop a permitted bot, or anything the bot runs, from using it. There is no secrecy from the bot that was given the credential, so treat a command variable as shared with that bot and save only values you would let it use unattended, scoped to what it needs.

Command variables are managed in the same Vault as other reusable credentials. The request card a bot opens in a thread shows a command variable's variable name in place of a site.

## Saved website logins

When you want a bot to sign in to a website by itself, ask it to save the login. It calls `request_secret` with `"auth": {"type": "login"}`, the origin of the sign-in page, and the labels of the values the site signs in with:

```json
{
  "label": "Example sign-in",
  "purpose": "password",
  "credential": {
    "name": "example_login",
    "origin": "https://login.example.test",
    "auth": { "type": "login" }
  },
  "fields": ["ID number", "Phone number"]
}
```

Without `fields`, the card asks for a Username, which starts visible, and a Password, which starts hidden, as logins always have. A login has 1 to 8 fields, each with its own label. The card asks for one value per field, and a field the bot names starts visible only if every word of its label is an identifier word (ID, phone, email, account, username) or a plain filler word (number, name, address, last, digits), in English or Hebrew, such as "ID number" or "Phone number"; any other word, such as a password, PIN or code, or a misspelling, keeps it hidden, as does every label that isn't recognised. You can switch any field between hidden and visible before saving, and what you save is final: the bot names the fields but cannot send a visible flag, so the label is all it can influence, and the server only accepts an answer with exactly the fields the card asked for. All values are stored encrypted in the same way as other reusable credentials.

The card also has a **Save to Vault** switch, on by default, that only you can turn off. With it off, the login is kept encrypted for the run that asked for it and never goes into a vault. Only that run can fill it, on the card's HTTPS site, and it is hidden from tool output like a saved login. It is deleted when the run ends, however it ends, so a later run has to ask again. The site's cookies stay, so the bot may still be signed in.

To sign in, the bot fills fields found with `browser_snapshot`, naming each by its label:

```json
{
  "actions": [
    { "kind": "fill_secret", "ref": "e3", "secret": "example_login", "field": "ID number" },
    { "kind": "fill_secret", "ref": "e4", "secret": "example_login", "field": "Phone number" },
    { "kind": "click", "ref": "e5" }
  ]
}
```

`"username"` and `"password"` also name a login's first visible and first hidden field, so a bot can fill a login saved in settings without knowing its labels.

The backend decrypts the value and the page browser types it only if the page is still on the saved origin at that moment, so a login cannot be typed into another site or a page that redirected. The origin must be HTTPS: `RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP` does not apply to website logins. A hidden field goes only into a password field, and a visible field only into a text, email or tel input. A visible field can appear on the page and in screenshots. A site's "show password" control still works normally; revealing a hidden value can make it visible in screenshots. Values travel to the computer over stdin, not command-line arguments. Snapshots never report the value of a field that holds a saved login. In every run, not only the one that filled it, tool results such as page results, command output and file reads are scrubbed of each saved login's hidden fields in plain, URL-encoded, form-encoded and base64 form; hidden values shorter than 6 characters are only scrubbed in the run that fills them. In the run that fills a login, page results are also scrubbed of its visible fields of 6 or more characters, which covers a site that echoes them in page text; shorter visible values are not scrubbed because redaction replaces every occurrence. Later runs leave visible fields readable, since one is often the user's own email address. Only this bot's own runs scrub its hidden fields: on a Team Computer, other bots' runs don't, so use a Private Computer for a bot that signs in to sites. A login cannot be used with `secret_request`. Fills need no approval: saving the login is the approval, and it is bound to one site. Use `forget_secret` to remove it.

Logins saved before fields existed read as a visible Username and a hidden Password, and fill exactly as before.

## Payment cards

A bot asks for a card with `request_secret` and auth `{ "type": "card" }`, with no origin. The card asks for the number, expiry, security code, name on card and, optionally, a saved contact whose address bills it. The whole card is encrypted like any other value. `list_secrets` shows the bot only its brand, last four digits, expiry, name and billing contact, never the number or security code.

The bot types a saved card with `browser_act` `fill_card`, passing `card` and `site`, the checkout page's HTTPS origin:

```json
{
  "actions": [
    {
      "kind": "fill_card",
      "card": "visa-4242",
      "site": "https://shop.example.test",
      "field": "number"
    },
    {
      "kind": "fill_card",
      "card": "visa-4242",
      "site": "https://shop.example.test",
      "field": "expiry"
    },
    {
      "kind": "fill_card",
      "card": "visa-4242",
      "site": "https://shop.example.test",
      "field": "cvc"
    }
  ]
}
```

Every call that types a saved card asks the person first, naming the card and the site ("Pay with Visa ·· 4242 on shop.example.test?"). Allow once is the only way to approve it, and a webhook run, which nobody can answer, is refused. One call types one card on one site, and the page browser types it only while the page is still on that origin, including a payment frame inside it. `postal_code` comes from the billing contact. Approving the card names no amount, so the click that places the order still asks, with the total the page shows; a call that types the card and presses that click asks once, showing both. That click counts against your [spending limit](./approvals.md#spending-limit), if you set one. Every run of the bot hides each saved card number from tool output, in plain, digits-only, spaced and dashed forms. The security code is not hidden, as for a wallet card: at 3 or 4 digits, hiding it would blank every total and order number that contains them.

## Contacts

A contact is a name, address, phone or email, the user's own or someone else's, such as `home`, `mom` or `office`. A bot asks for one with `request_secret` and auth `{ "type": "contact" }`, with no origin. A contact is not secret from the bot: `list_secrets` returns its fields, and the bot types them like any other text. It is still encrypted at rest.

## Managing the vault

Owners can manage what is saved without asking the bot. Open **Settings → Vault** on web, the
desktop app or mobile. It lists every item by its title, which the owner can change (a card without
one shows as "Visa ·· 4242", a login as its site), with a line from the item: a login's username, a
card's expiry, a contact's name and city. New adds a login, card, contact, API key or variable.
Opening an item shows its fields; protected values show only after you confirm it's you. From
there you can edit an item, add a note on when the bot should use it, which `list_secrets` shows
the bot, or remove it after confirming. Remove deletes the saved value immediately. Asking the bot
to `forget_secret` a name only removes it; it does not list or replace one.

A sign-in without a password, such as an ID number and phone number, uses the same login card. CAPTCHA and passkeys still use `request_takeover`, as does any sign-in you prefer to do yourself.

### One-time codes

When a site texts or emails you a code, the bot calls `request_secret` with `oneTimeCode: { "origin": "https://www.example.com" }` and shows a card, titled "Code for" that site's host, for the code. Only the person the run belongs to can answer it. The code is 4 to 12 characters, letters and digits in groups joined by single dashes, spaces dropped; anything else is refused. It is kept encrypted for that run only, never saved to the vault, and never shown to the bot: it types it with `browser_act` `fill_code` into one field on the page. Like a login fill, the page browser types it only while the page is on that exact HTTPS origin, and only into a text, email or tel input that looks like a code box (it says so, takes digits, is named or labelled like a code, or holds 4 to 12 characters). The field is drawn as dots, and so is the slot widget around it that shows the digits, and its value stays out of snapshots; slots drawn more than 50 ms late, more than three levels up, or after the page remounted them may still show in a later screenshot, and the masking may also cover a container that shows the same characters elsewhere. Dashes are dropped for a numeric box. A code is used once: it is claimed just before the page is asked, so two fills never both get it, and a fill the page refused gives it back. After a fill the page took, the code is kept only so the run goes on hiding it, in the forms a page might draw it (one digit per line, spaced, or dashed), and it is deleted when the run ends. A wrong or expired code needs a new request, which shows a new card. A code box that refuses the fill, such as one input per digit, a password-type or number-type input, or a field in a frame from another site, falls back to `request_takeover`. The code-box check is broad on purpose: another field on the same site named like a code, such as a promo or postal code, qualifies too. This needs a computer image that includes the code fill; an older image reads the fill as a password and types only into password-type inputs on that origin, so it falls back to `request_takeover` for a code box.

When the bot has its own email address and the site sends the code there, the bot usually does not need to ask. When it calls `request_secret` for a code, it first looks in its inbox, again once the card is saved (for mail that came while it was being saved), and again each time mail arrives while its card is open. An email that would answer two runs' waiting cards answers neither, on every one of those looks. It uses a code only when all of these hold: the run may read the inbox (the owner's own run, not one started by another bot's message, in a group, or in a chat that reaches other people); the page is HTTPS, and the run's own browser reports the page on that exact origin when the bot asks (an origin the bot names is not enough, written with or without a trailing slash or a default port, and with no computer running or no page open the card opens); the page's site is not a public mailbox domain (gmail.com, outlook.com, yahoo.com and the others the app knows), where anyone with an address can send mail signed by the site; the email arrived after the run started and no more than five minutes before the request, and after the bot's last answered secret request in any run; it passed its sender's signature check, was sent to the bot, was not sent by the bot or by any bot on this server's mail domain, and is known not to have come through a mailing list (a `List-Id` or `Precedence: list` header; mail saved before this release told lists apart is never used); its sender's site is the page's, where a site is the registrable domain and each customer's domain under a shared hosting suffix (such as `victim.duckdns.org`) is its own site (mail from `example.com` for `login.example.com`); its subject and text hold exactly one code, of 6 or more characters or with letters; and no run has taken a code from it yet. Emails from the site with no code or with two are skipped, so a newer welcome email does not hide an older code; if the remaining emails hold different codes, none is taken. An email that calls a code old, previous, expired or invalid gives nothing, even when it also names a current one. A number counts as a code only when the sentence or line it stands in is written in one of a few fixed forms: a code word (code, passcode, OTP, 2FA, one-time password, or the same word in one of the app's languages), then an optional colon, equals sign or dash, then the code ("Your verification code is 482913", "Code: 482913"); the code, then the code word ("482913 is your sign-in code"); or a line that only names a code ("Your code:", or the subject) right over a line holding nothing but the code. Around the code word and between it and the code only a short fixed list of words per language is allowed: the little words such a sentence has (your, is, enter, to sign in) and sign-in qualifiers (verification, security, one-time, confirmation, login). Anything else in that sentence, another number of any length, a word the list does not hold, or a noun that makes the code word name something else (tracking code, code de suivi, order, ZIP code, promo code, QR code, country code, error code, code postal), means the sentence gives nothing: the word next to the code word has to be on that list, so no list of nouns to deny is kept. A bare PIN is not a code word, as it names a postal area in some countries. Each sentence is read on its own, so "Order 48213977. Your code is 731905" gives 731905, while a number alone on a line with no code word right over it, a code on a line over its code word, or a code in brackets gives nothing. A sentence longer than 200 characters gives nothing. More emails fall back to the card than a looser reading would allow; that is the point, as a wrong number costs a sign-in attempt. A code is 4 to 8 digits, two equal groups of 3 or 4 digits split by a space or a dash, or 6 to 8 capital letters and digits with both. A number is skipped when a letter, digit, `$`, `€`, `£`, `¥`, `/`, `\`, `@`, `%` or `_` touches it on either side, when `#`, `+`, `.`, `,`, `=`, `&`, `?` or `-` comes right before it, when `.`, `,`, `:` or `-` comes between it and a letter or digit after it, or when a digit is one space away, or one dot or dash before it (Chinese, Japanese and Korean letters may touch it); so is a 4-digit number from 1900 to 2099. A 4- or 5-digit code is never taken, and the card opens: hiding it would mean hiding that bare number in everything the run reads, which would blank years, prices and other short numbers too. It still counts as a second code. Taking an email's code is a database claim on the message (its signature, which a copy delivered again after the bot deleted the email shares), made in the same transaction that stores the code or answers the card, so when that fails the email stays for the next look: the message gives its code to one run, even when two runs or a run and arriving mail look at once, and a run takes at most one emailed code per site; after that the card opens for the owner. The sender is encrypted, so the inbox is read newest first in batches of 50 and filtered to the site's mail, up to 500 of the site's emails in the window: mail from other senders does not hide the site's, up to 5,000 emails read in all, past which the card stays for the owner. Other automated mail, such as an auto-generated `Auto-Submitted` header, is still used: sites send codes that way, and those headers are not signed, so a sender could leave them out anyway. The code is then stored and typed exactly as one answered on the card would be, and the page browser again types it only on that exact origin. A request it answers shows no card and sends no notification; a card it answers looks answered by the owner, and the run goes on. A card the owner answered first stays answered, and the email does nothing. Otherwise the card opens as before, and the owner can still answer or dismiss it; so does any failure while looking (the inbox or a connected mailbox cannot be read), with only the error's name in the log, and a failure while answering an open card from arriving mail never fails that mail's delivery. That covers a site that sends from another domain, a code sent by text message, an email with two codes, mail that came while the inbox was over its daily limit, a run that may not read the inbox, and any other run's card. The email itself stays in the inbox with the code in it. From the moment the server takes the code, `read_email` in that run hides it in every email it returns, in every field but the email's id and time (sender, recipients, subject, text, preview and file names): in the same forms as a typed code, and as its characters in order with any run of spaces (no-break, zero-width and other Unicode spaces too), line breaks, dots, dashes or middle dots between them. In a run holding such a code, a search reads up to 1,000 emails in its time range itself, newest first (with `since`, oldest first), and matches only the text after hiding, with the `[redacted]` mark left out, so a search that would match only the hidden code, or the mark itself, returns, `nextSince` included, exactly what a search for text found nowhere returns. In such a run `read_email` also gives the run no attachment from any email, listing each file as unavailable: a file could carry the code in a form that cannot be hidden. Any other run searches the database as before. While a code row of a run that took a code from an email cannot be read (the secret store is down, or a key is wrong), no attempt of that run starts (the setup is retried, as any setup failure is), `read_email` in a running attempt returns an error asking to try again, and `request_secret` keeps the row as a spent code, still hidden once it can be read, instead of deleting it: any email might hold the code, so none is shown until it can be hidden. The `[redacted]` mark shows where the code was, as it does when the email is read. A background helper the run starts cannot use `read_email` or `request_secret`. That is all it guarantees: an email the bot read before the code was taken was already seen, including one in a routine's prompt, and the bot can still read new mail as it arrives with `read_email` `waitSeconds`. The tool descriptions tell the bot to use `request_secret` for a code it must type into a page.

The owner can also let a bot take the code from the email they connected to Rakazo themselves, with the bot's "Fill sign-in codes from my connected email" switch, off by default. Only the bot's creator sees and sets it, since it reads their mail; a bot that comes to exist any other way (created, duplicated, imported from an account archive) starts with it off. While that is on (checked again just before each read, so turning it off stops a running attempt too), a `request_secret` for a code that finds no email from the site holding a code in the bot's own inbox reads (an inbox holding the site's emails with different codes, or more mail than it reads, keeps the card), in each email connection the owner made in that Space, the newest five emails from the site in the same window as the bot's inbox (after the run started and no more than five minutes before the request), once when the bot asks and once more after the card is saved. The provider's search by sender is loose (a name or another domain holding the site's domain matches), so the mailbox is read page by page, newest first, until five emails are from the site itself, for at most ten pages, past which the card opens: mail from other senders on those pages does not hide the site's; mail arriving later does not answer the open card, so the owner answers it or the bot asks again. The bot's own inbox is looked at first, and a site's code is filled once per run across both. Each email is held to the same rules as one in the bot's inbox: it must pass its sender's signature check, be addressed to that mailbox, not come through a mailing list, come from the page's site, which is not a public mailbox domain nor the mailbox's own domain (where anyone with an address there can send it signed mail), have arrived in that window and after the last answered secret request of the bot or of any of the owner's runs in the Space (the owner may have typed that email's code into another bot's card), and hold exactly one code; a message answers one run only, whichever connection to its mailbox reads it. Only the owner's own connections are read, only in a run that may read the bot's inbox, and only with read calls: the provider's profile, a search by sender since the exact moment the window opens, and the raw message. Nothing from the mailbox is stored or logged; a listing in a shape that cannot be read, a listed message without an id or an arrival time or that cannot be read, a signature that cannot be checked for now, or a read that takes more than three seconds, opens the card (never another message answering for what was not read), with only the error's name in the log. A code taken this way is hidden in `read_email` as one from the bot's inbox is; a connector tool that reads that mailbox returns the email as it is, code included, as it could before the code was taken. The connection's grant is whatever the provider gave when the owner connected it, which is usually wider than reading; this feature uses only the read calls above, so an owner who wants a narrower grant should connect a mailbox used for nothing else. The run that holds the code is the only one that hides it; another run, or another bot, that reads that email sees the code as it does one the site sent to the bot's inbox.

The value is typed into a real browser on the bot's computer. Anything that can read that browser, including the bot's own shell commands through the page or its debugging port, could read a filled field. Keeping the value out of model input stops accidental disclosure, not a bot that sets out to extract it. Save logins only for accounts you would let the bot use unattended.
