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

Each variable a command is sent with is recorded as a use of it (`credential.used` in the [audit log](./self-host-audit-log.md#what-is-recorded)) and listed in its item's activity: once per variable each time a run starts or resumes, however many commands that run then runs, and once per variable for each check of a [routine](./routines.md#when-something-changes) that watches a command. The record never holds the value, and has no site, since a shell is not one. A command that is refused, or that never reaches the computer, is not a use, and neither is a run reading the variables when it starts in order to hide them from its output. A variable a bot may not use (see Managing the vault) is neither exported to its commands nor recorded.

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

The backend decrypts the value and the page browser types it only if the page is still on the origin the fill was sent for at that moment, which is the saved origin or one of the other sites its owner added (below), so a login cannot be typed into another site or a page that redirected. The origin must be HTTPS: `RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP` does not apply to website logins. A hidden field goes only into a password field, and a visible field only into a text, email or tel input. A visible field can appear on the page and in screenshots. A site's "show password" control still works normally; revealing a hidden value can make it visible in screenshots. Values travel to the computer over stdin, not command-line arguments. Snapshots never report the value of a field that holds a saved login. In every run, not only the one that filled it, tool results such as page results, command output and file reads are scrubbed of each saved login's hidden fields in plain, URL-encoded, form-encoded and base64 form; hidden values shorter than 6 characters are only scrubbed in the run that fills them. In the run that fills a login, page results are also scrubbed of its visible fields of 6 or more characters, which covers a site that echoes them in page text; shorter visible values are not scrubbed because redaction replaces every occurrence. Later runs leave visible fields readable, since one is often the user's own email address. Saved logins belong to you, not to one bot, so in a Space only you use, every run on its Team Computer scrubs every login in the vault that Space uses, whichever bot filled it and whichever bots may use it. In a [shared Space](./spaces.md#share-a-space), other members' runs scrub only their own logins, so sign in from a Private Computer there. Each run reads the vault when it starts, so another bot's run that is already going doesn't scrub a login saved or changed after it began, and a login kept without saving is only scrubbed in its own run. On any computer, later runs no longer scrub a login's old values once it is changed or removed, or the logins in a vault the Space has stopped using. Redaction hides text, not sessions: the other bots on a Team Computer can use the sites a bot signed in to, so use a Private Computer for a bot whose sign-ins they must not use. A login cannot be used with `secret_request`. Unless the login is set to Ask first (see Managing the vault), fills need no approval: saving the login is the approval, and it is bound to its site and to the other sites its owner adds for it. Use `forget_secret` to remove it.

A login can also fill on up to 10 other exact HTTPS origins, such as `https://www.example.test` for a login saved on `https://login.example.test`. Only the owner sets them, in **Also on** when editing the login in Settings; a bot cannot add one, and a wildcard such as `https://*.example.test` is refused. The backend sends the page browser the one origin, of the login's own and its others, that the page was last reported on, so the page browser's check stays the same and an older computer image needs no change: a page that moved to any other origin, a lookalike host or plain HTTP is refused. `request_secret` finds a login for any of its origins, by name or by site, and keeps it saved at its own site; by site, it takes the one login saved at that site, or when none is, the one login also on it. If the page moved to another of the login's sites without the run seeing it, the fill is refused, and the bot is told to open the saved site and fill again; a fill goes by the page the run last saw, so after a snapshot it fills on the page's current site instead. Other sites apply to the page itself, not to frames: a sign-in form in a frame fills only when the frame is on the login's own site and the page around it is not one of its other sites, so for a sign-in frame, save the login for the frame's site and don't add the page around it. A bot can ask to move a login to another site only while the login has no authenticator key and no other sites: only its owner sets them, for the site it has, and a login card shows neither, so `request_secret` with `replace` is refused for such a login and the bot is told to ask you to change its site in the Vault. If you add a key or a site while such a card waits, answering the card moves the login without them. Whole-domain matching is not supported.

A login can also keep an **Authenticator key**, a base32 secret or an `otpauth://totp` link (SHA-1, SHA-256 or SHA-512, 6 or 8 digits, 30 or 60 seconds), which the owner adds when editing it in Settings. Spaces, dashes and case don't matter and padding may be left off, but a secret whose length can't be whole bytes, or whose padding doesn't fill its last group, is refused as a likely typo. It is stored encrypted inside the login's value, and a save that leaves it out, such as a login card the user answers or an older app, leaves it as it is, whether that is a key or none: a key you removed stays removed until you type one again. Clearing the field removes it. A bot types the login's current code with `browser_act` `fill_code` and `secret`, the login's name: the backend computes the RFC 6238 code at that moment and sends it through the same code fill as a code the user typed, so it is typed only on one of the login's sites (its own or one it is also on), into a code box, and kept with the run's typed codes: each code is typed once per run and hidden from tool output in every attempt of the run, also after a restart. The backend can't see whether a site took a code, so it reads the site asking again as a refusal: a code requested within 5 minutes of the last one typed for the same login in that run is a repeat. Three in a row, each within 5 minutes of the one before, stop the login's codes for every run as the third is typed, with no fourth request needed, and the bot is told to ask the user for the code instead, since a site that asked twice more likely has another key; no run types that login's codes again until its owner saves the login in the Vault, and the time it was saved stays as it was. Only the codes of the value as saved count together, so the count starts over once the login is saved again. A stop is cleared only by the owner's own save in the Vault: answering a login card a bot asked for keeps the saved key, so it leaves the stop in place, and renaming or re-setting the item changes neither. A code the page clearly never typed, such as one refused because the page is on another site, gives its place back, and the stop with it unless three other codes still stand; a fill the page may have taken keeps both, whether or not the site accepted the code. Codes further apart never count, so a login whose codes work is used as often as a long run, or several runs, need. The bot never sees the key or the code; the key is hidden from tool output in every run, as a saved password is, in the forms a page shows it (as saved, in either case, grouped in fours with spaces or dashes, or inside its setup link); like a password, a run hides the keys saved when it started, and a key added or changed later from the run's first fill of that login. `list_secrets` tells the bot which logins can type a code (`authenticatorCode`) and their other sites (`alsoOn`). A blocked login gives no code, and each use is recorded as `credential.used`. A login the person entered for one run only, without saving it, has no key, so the bot asks for a code instead. Any run that can use the login can type its code, including group and channel runs, with no card unless the login is set to Ask first; such a login asks for the code too, saying so on its card, and a webhook run can't use it. Keeping the key beside the password makes the two one factor for anyone who can use the vault, so add one only where the bot must sign in on its own.

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

A contact is a name, address, phone or email, the user's own or someone else's, such as `home`, `mom` or `office`. A bot asks for one with `request_secret` and auth `{ "type": "contact" }`, with no origin. A contact is not secret from the bot: `list_secrets` returns its fields, and the bot types them like any other text, so a contact has no uses to record or list. It is still encrypted at rest.

## Managing the vault

Owners can manage what is saved without asking the bot. Open **Settings → Vault** on web, the
desktop app or mobile. It lists every item by its title, which the owner can change (a card without
one shows as "Visa ·· 4242", a login as its site), with a line from the item: a login's username, a
card's expiry, a contact's name and city. New adds a login, card, contact, API key or variable.
Opening an item shows its fields; protected values show only after you confirm it's you. From
there you can edit an item, add a note on when the bot should use it, which `list_secrets` shows
the bot, or remove it after confirming. Remove deletes the saved value immediately. Asking the bot
to `forget_secret` a name only removes it; it does not list or replace one.

Each item's **Bots** setting says which bots may use it. Every bot may by default. Block keeps every
bot from it (a contact can't be blocked), and choosing bots limits it to those bots; none chosen
means no bot uses it. In a shared Space you can choose any of its bots, and your choice covers only
your runs with them, since each person's runs use their own vault. A login can also **Ask first**:
each `browser_act` call that signs in with it shows the user a card, such as "Sign in to
example.com with Work login?" (its title, never a username), naming the one site it fills on (the
page's, when that is one of its other sites). When the call types the login's authenticator code,
the card says so under the question: "This types the login's authenticator code." The card shows
on every such call, also in Never ask and over an Always allow rule; its only answers are Allow
once and Deny, and only the person whose run it is can give one. Allowing covers that one call and
what the card said: the fields of the login the call fills, its code only when the card said so,
on the site the card named, for the login as it was saved when the card was shown. The call's
other steps, such as the click that submits the form, run with it; a call that would also pay or
type a saved card is refused instead. An approval for a password never covers a code, so a code
asked for later shows its own card. Any later call asks again, and so does a call allowed before
the login was saved again, as when a key or a site was added while the card waited. Declining
types nothing, and a webhook run can't use the login, as with saved cards. A login saved by
`generate_secret` with `command: true` also has a command variable copy of its password,
`<name>-password`: that copy is its own item with its own Bots setting, so Ask first, Block or
chosen bots on the login don't cover it; set it too. Bots are chosen in the Space they are in:
limiting an account item in one Space leaves the bots of your other Spaces as they were, and a
Space with its own vault never uses account items. A bot treats an item it may not use as missing,
while a value it saw earlier stays hidden from its runs.
The migration installs restrictive row-security policies that hide restricted vault items from
previous-release connections, including system connections. Unrestricted items remain readable
and writable. Any per-Space bot limit hides that account item from old connections in every
Space, since an old writer could overwrite it. Run-only logins, codes and secrets are unavailable
to old connections for an owner with a restricted item in the account or current Space's vault:
these temporary rows cannot reliably be linked to an item, so allowing them could bypass its
restriction. Other owners and Spaces keep working. Current connections declare support for item
policies alongside their tenant settings. This requires the restricted runtime database role used
by supported deployments: a superuser or a role bypassing row security cannot enforce this
boundary. An action that already received a value before the migration or policy change may
finish; database policies cannot recall values already handed out.

**Import CSV** in the New menu reads a password manager's CSV export on your device; the file is
never uploaded. It matches common column names for the name, site, username or email and
password, takes the first HTTPS site of a cell that lists several (a site
written without `https://`, such as `example.com`, counts as HTTPS; `http://` does not), reads a file
of up to 5 MB, and shows how many logins it will add before
saving, with a line saying that bots can use each one until you change its Bots setting. A Vault
holds 100 items, so when a file has more new logins than there is room for, the
review counts the rest as "Vault full". It still sends them, up to 100 at a time, and the server
decides which fit; its result lists any it had no room for. An import that stops partway says some logins
may have been saved; importing the file again skips them.
It leaves out rows whose site isn't HTTPS or is one no login may be saved for, rows without a password, rows
with a value too long to save, rows with more cells than the header, and logins already saved for the same site and
username, and lists the first few of those rows by the file's line each starts on and name or site,
never by username or password. A row the file repeats is listed as repeated until the import has
saved or turned down its first copy, then as already saved, or as turned down the same way. A long
name is shortened to fit. Notes aren't imported, since bots see an item's note
and an export's notes can hold private data such as security answers; add one by hand where it
helps the bot. If a saved login can't be read for now, the import stops there; importing the file
again later counts what was saved as already saved. Each login it adds is a new item that bots may use, like one
you add yourself, and is audited as `credential.created`. As with every vault event, a shared
Space's organization names the login only when you are a full member of it. A guest's full record
of an item in their account vault goes to the organization they own; one in the Space's vault is
recorded only in the Space (see the [audit log](./self-host-audit-log.md#what-is-recorded)). An
item's activity lists its 20 latest uses as the audit log records them, one for each item and site
each time a run starts or resumes and one for each check of a routine, not one for each field
typed: a login, card or code a page may have typed, an API key a request may have carried, and a
command variable a shell command was sent with. A guest sees a use in a
shared Space without its site where only the unnamed record exists: a use of an item in the
Space's vault, or any use when they own no organization. A command variable's use never has a
site. Authenticator keys aren't imported; add
one in the login's editor where a bot must sign in on its own. A file whose quotes are broken is
not read at all, so no password is read differently from the export. Delete the export file
afterwards: it holds your passwords unencrypted.

A sign-in without a password, such as an ID number and phone number, uses the same login card. CAPTCHA and passkeys still use `request_takeover`, as does any sign-in you prefer to do yourself.

### One-time codes

When a site texts or emails you a code, the bot calls `request_secret` with `oneTimeCode: { "origin": "https://www.example.com" }` and shows a card, titled "Code for" that site's host, for the code. Only the person the run belongs to can answer it. The code is 4 to 12 characters, letters and digits in groups joined by single dashes, spaces dropped; anything else is refused. It is kept encrypted for that run only, never saved to the vault, and the bot never sees it: it types it with `browser_act` `fill_code` into one field on the page. Like a login fill, the page browser types it only while the page is on that exact HTTPS origin, and only into a text, email or tel input that looks like a code box (it says so, takes digits, is named or labelled like a code, or holds 4 to 12 characters). The field is drawn as dots, and so is the slot widget around it that shows the digits, and its value stays out of snapshots; slots drawn more than 50 ms late, more than three levels up, or after the page remounted them may still show in a later screenshot, and the masking may also cover a container that shows the same characters elsewhere. Dashes are dropped for a numeric box. A code is used once: it is claimed just before the page is asked, so two fills never both get it, and a fill the page refused gives it back. After a fill the page took, the code is kept only so the run goes on hiding it, in the forms a page might draw it (one digit per line, spaced, or dashed), and it is deleted when the run ends. A wrong or expired code needs a new request, which shows a new card. A code box that refuses the fill, such as one input per digit, a password-type or number-type input, or a field in a frame from another site, falls back to `request_takeover`. The code-box check is broad on purpose: another field on the same site named like a code, such as a promo or postal code, qualifies too. This needs a computer image that includes the code fill; an older image reads the fill as a password and types only into password-type inputs on that origin, so it falls back to `request_takeover` for a code box.

The value is typed into a real browser on the bot's computer. Anything that can read that browser, including the bot's own shell commands through the page or its debugging port, could read a filled field. Keeping the value out of model input stops accidental disclosure, not a bot that sets out to extract it. Save logins only for accounts you would let the bot use unattended.
