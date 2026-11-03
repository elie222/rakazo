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

## Managing saved credentials

Owners can manage what is saved without asking the bot. Open **Settings → Vault** on web, the
desktop app or mobile. It lists each credential's name, origin and authentication type. From there
you can show a value, replace it on the same destination, or remove one after confirming. Remove
deletes the saved value immediately. Asking the bot to `forget_secret` a name only removes it; it
does not list or replace one.

A sign-in without a password, such as an ID number and phone number, uses the same login card. Texted or emailed one-time codes, CAPTCHA and passkeys still use `request_takeover`, so a code is typed on the live screen rather than saved, as is any sign-in you prefer to do yourself.

The value is typed into a real browser on the bot's computer. Anything that can read that browser, including the bot's own shell commands through the page or its debugging port, could read a filled field. Keeping the value out of model input stops accidental disclosure, not a bot that sets out to extract it. Save logins only for accounts you would let the bot use unattended.
