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

The value is encrypted in Postgres `bot_secrets` using the deployment's `ENCRYPTION_KEY` (AES-256-GCM with record-bound authentication). Only the run's user can submit a reusable credential. It belongs to that user, space and bot, survives later runs, and is deleted when its owner, space or bot is deleted. Names, destinations and authentication configuration are metadata; `list_secrets` returns those fields without values. No hosted credential service or prebuilt connector is required.

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

Command variables are managed with the same Credentials section as other reusable credentials: web and the Electron-hosted web UI can add, replace and remove one. Mobile has no credentials settings screen, but the request card a bot opens in a thread shows a command variable's variable name in place of a site, so a bot can obtain a command variable value on the phone; listing, adding, replacing and removing one is web and desktop only.

## Saved website logins

When you want a bot to sign in to a website by itself, ask it to save the login. It calls `request_secret` with `"auth": {"type": "login"}` and the origin of the sign-in page:

```json
{
  "label": "Example sign-in",
  "purpose": "password",
  "credential": {
    "name": "example_login",
    "origin": "https://login.example.test",
    "auth": { "type": "login" }
  }
}
```

The card asks for a username and a password. Both are stored encrypted in the same way as other reusable credentials, and the model sees neither. To sign in, the bot fills fields found with `browser_snapshot`:

```json
{
  "actions": [
    { "kind": "fill_secret", "ref": "e3", "secret": "example_login", "field": "username" },
    { "kind": "fill_secret", "ref": "e4", "secret": "example_login", "field": "password" },
    { "kind": "click", "ref": "e5" }
  ]
}
```

The backend decrypts the value and the page browser types it only if the page is still on the saved origin at that moment, so a login cannot be typed into another site or a page that redirected. The origin must be HTTPS: `RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP` does not apply to website logins. The value goes only into an input of type text, email, password, or tel. Values travel to the computer over stdin, not command-line arguments. Snapshots never report the value of a field that holds a saved login. Page results are also scrubbed of the password, and of the username when it is 6 or more characters, which covers a site that echoes it in page text; shorter usernames are not scrubbed from page text because redaction replaces every occurrence. A login cannot be used with `secret_request`. Fills need no approval: saving the login is the approval, and it is bound to one site. Use `forget_secret` to remove it.

## Managing saved credentials

Owners can read back what is saved without asking the bot. In the web app, open a bot's settings,
expand **Advanced**, and use the **Credentials** section. It lists each credential's name, origin
and authentication type and never its value. From there you can add a credential, replace its value
on the same destination, or remove one after confirming. Remove deletes the saved value immediately.
The Electron desktop app hosts the same web UI, so it has the same section.

Mobile does not host that web settings shell, so it has no credential management screen.
The thread credential card still works on the phone, including website logins, and that is how a
bot obtains a value there. Listing, replacing, and removing saved credentials stays on the web
section. Asking the bot to `forget_secret` a name only removes it; it does not list or replace one.

Two-factor codes, CAPTCHA and passkeys still use `request_takeover`, as does any site where you prefer to sign in yourself.

The value is typed into a real browser on the bot's computer. Anything that can read that browser, including the bot's own shell commands through the page or its debugging port, could read a filled field. Keeping the value out of model input stops accidental disclosure, not a bot that sets out to extract it. Save logins only for accounts you would let the bot use unattended.
