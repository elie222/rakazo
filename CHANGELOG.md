# Changelog

Notable product changes in Rakazo. See GitHub Releases for tagged builds.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A server running on macOS offers a keyless **macOS** voice provider that reads replies with the voices installed on that Mac. Speech is rendered into a clip, so it plays and stops on the listener's device like any other voice ([macOS voices](docs/self-host-models.md#macos-voices)).
- `MASTER_KEY_PROVIDER=aws-kms` wraps content keys with an AWS KMS key, so the master key no longer sits on the server. `content-encryption rotate` moves existing keys over ([content encryption](docs/content-encryption.md#external-key-management)).
- Ollama Cloud preset in Models settings on web and mobile, using an OpenAI-compatible connection with model discovery and no deployment configuration.
- Optional point-in-time recovery for the production Compose database: an opt-in sidecar streams encrypted WAL and daily base backups to any S3-compatible bucket, so a lost server costs about a minute of writes instead of up to a day, and `pitr.sh restore` recovers to any moment in the retention window. Off unless enabled; enabling reloads Postgres without restarting it ([point-in-time recovery](docs/self-host-backups.md#point-in-time-recovery)).

### Fixed

- Arguments of a stdio MCP server, which can carry tokens, are stored encrypted with its other credentials and are no longer returned to clients; leaving them blank when editing keeps them. Arguments saved earlier move into encrypted storage automatically when the API starts.
- Approval rules judge each action in a Composio batch even when Composio is connected as an MCP server, so "Always allow" on one action no longer allows every other action through that server.
- Mobile threads now show work started by another client as soon as the run starts, without hiding waiting runs or another group member's error.
- Hovering a message no longer places its entire row above the floating chat header and other higher-priority controls.
- "Messaged" and "Message from" markers in a bot's chat are centered like the time separators on web and mobile, so a message from another bot no longer sits on the right with your own messages.
- The chat name and header buttons stay above messages while scrolling, including a message's actions while its menu is open.
- Mobile chat and call subscriptions reject oversized event frames and release their readers after cancellation or connection failure.
- Thread snapshot recovery replays durable events instead of retaining their payloads in memory, without repeating notifications already delivered. Late voice-call snapshots no longer replace newer work or a replacement call.
- The offline installer now rejects missing local inputs without downloading files or starting services.
- Development backups use private permissions. Restore validates files before importing SQL, replaces the saved data tree instead of merging it, and preserves the previous tree for recovery.
- Gemini runs could fail with "Function call is missing a thought_signature" after earlier tool calls in the same turn lost their signature on the way back to Google. Every Gemini request now carries the original signature when one is usable and Google's documented placeholder otherwise.
- Images and files a bot attached to its reply in a Telegram chat were dropped, so only the text arrived. They now follow the text as their own messages: PNG, JPEG, GIF and WebP images under 10 MB as photos, anything else up to 50 MB as a document. A file that still cannot be sent after its retries is replaced by a short note naming it, and the text is never sent twice. Other chat apps still receive the text only.
- Self-hosted stacks behind a reverse proxy on the host gave every user one shared sign-in rate limit, so ten failed sign-ins anywhere locked everyone out for 15 minutes. If `TRUSTED_PROXIES` is unset, the API in a container now trusts loopback and the stack's own networks. Outside a container it trusts loopback only. Each client gets its own limit again, and bot computers still cannot choose their address.
- Upgrading a stack installed before restricted computer egress existed stopped its Docker computers from starting until the host firewall rules were installed. The updater now also adds a missing `POSTGRES_APP_PASSWORD` before it recreates services, so the newer Compose files start.
- A Railway computer whose sandbox had been destroyed could not start again: it failed with "Railway live screen requires PRIVATE networking" instead of creating a new sandbox, because Railway no longer reports networking for a destroyed sandbox. It now starts a new sandbox and restores the portable home.
- The Amazon Bedrock model picker was missing newer models available on Bedrock: Claude Sonnet 5.5, GPT-6 Luna, GPT-6 Sol and GPT-6.1 Sol, Grok 4.7, Kimi K3, GLM-5.3, and the India (`in.`) Claude inference profiles. They are now listed with their regional and global inference profiles until the bundled provider library ships them.
- Fish Audio speech can use a model other than s2.1-pro. Each Fish connection can set Speech model in Voice settings; `FISH_TTS_MODEL` is the default only when that field is empty (unset still uses s2.1-pro). A failed speak, transcribe, or voice-list request logs the upstream Fish status and message, including when the error body cannot be read, and the message returned to the client does not include the API key.
- A picture attached to an earlier message is now visible to the bot when a later turn asks about it, for a model that can see images. Only the current turn carried its images; older turns arrived as a text marker, so the bot asked for the picture again. The most recent user turns now keep their images, within a fixed turn, byte, and per-model image budget. A turn whose pictures exceed the byte budget keeps the newest ones that fit. If an earlier picture cannot be read, its history marker says it is unavailable.
- A bot on a reasoning model could answer with "No response. Try again." on a harder question: thinking is billed against the same output ceiling as the reply, and the 4k default left nothing for the reply itself. Reasoning models now get a 32k output ceiling instead, still bounded by whatever the model itself allows.
- A newly created bot's thread opened empty and stayed silent until given real work, so a misread `title`/`description`/`instructions` went unnoticed until it cost a run. Creating a bot now queues one turn where it states how it understood its role and asks for anything it needs.
- A message sent while that introduction was still running was answered by the intro, which cannot use tools. The message now waits until the introduction finishes and is answered in the following turn, and the introduction does not send a finish notification. A reply to a message from a linked chat app still goes back to that app. Messages held from different chats, such as a group channel and a direct chat, are answered in separate turns.
- A message sent to a bot while it was working on another bot's request joined that request. The bot's answer went back to the other bot and was folded under its "Message from" line, so the person who asked saw no reply. The message now waits until that request finishes or stops for input, and is answered in its own turn in the chat.
- A message sent while one of the bot's routines (or an inbound webhook) was running in the same thread was folded into that turn as steering, so the bot answered without the conversation ("I have no earlier context"). The message now waits until that turn finishes and is answered in its own turn with the full thread. A composer reply while that run is already waiting for input still answers the ask, unless a live conversational run is active to take the message.
- Every turn failed on Claude models through Amazon Bedrock with "input_schema does not support oneOf, allOf, or anyOf at the top level": `request_secret` declares its two destinations as a root `oneOf`, and Anthropic rejects the whole request for it. Root unions in tool schemas, including ones from MCP servers, are now merged into a single object schema before they reach a provider; the executor still enforces credential or `connectionId`, not both.
- Pipedream exposed every tool of every connected app at once, so a handful of apps could fill a run's tool list. Above 20 tools the connector now offers the same lazy catalog the MCP connector uses (`pipedream_search_tools`, `pipedream_load_tool`, and `pipedream_execute_tool`), with names grouped by app.
- The Needs you computer card in a thread now includes Open, which opens that bot's computer the same way the computer panel does, including from a group member bot.
- Bots with more than 20 MCP tools failed on every Claude model behind a Claude Pro/Max/Team sign-in with "You're out of extra usage": Anthropic rejects Claude Code OAuth requests that carry a tool named `mcp_*`. The lazy catalog wrappers are now `connectors_search_tools`, `connectors_load_tool` and `connectors_execute_tool`.
- Changing a bot's model, thinking level or voice failed with a validation error once its instructions outgrew the description limit, and saving any other setting overwrote those instructions with the shorter description text. Bot settings now put the description and instructions on the wire only when that field was edited, clamped to each field's own limit.

### Changed

- Only admins listed in `RAKAZO_ADMIN_EMAILS` can add or edit stdio MCP servers, and bots can add remote servers only. Deployments that use stdio servers should set `RAKAZO_ADMIN_EMAILS` before upgrading; existing stdio servers keep running ([integrations](docs/self-host-integrations.md)).
- Compose runs database migrations in a one-shot `migrate` container, the only one given the database owner login. Code running in the API or worker can no longer read that login from the container and bypass row-level security. Railway restarts its start script without the login after migrating.
- Mobile routine and connector mention suggestions load only when requested, with bounded routine-request concurrency.
- MCP result truncation no longer allocates an encoded copy of the full oversized result.
- Sitemap filtering reads blog category counts only for category URLs, without caching content across builds.
- Linux idle probes inspect background-work descriptors in one process. Browser shutdown polls the selected browser and checks for a replacement before clearing lock files.
- Browser unit tests use jsdom's isolated local storage on Node 26 instead of inheriting the host storage global.
- The production and source-checkout Compose stacks run Postgres 18 instead of 16. An existing install runs `infra/compose/upgrade-postgres.sh` once ([upgrading to Postgres 18](docs/self-host-upgrading.md#upgrading-to-postgres-18)): it copies roles, passwords and databases to a new volume, checks grants, row-level security and row counts, and leaves the Postgres 16 volume as it was for rollback. Until then the new database container refuses to start on the old volume instead of starting empty, and production deploys stop before replacing anything. The published-images stack and the desktop app stay on Postgres 16.
- A bot's Model field on the web and in the mobile app, and the mobile model settings, now mark models that cannot read images, as web Settings already did. Moving a bot to a text-only model is no longer a silent loss of image reading.
- Message bubbles in the web/PWA transcript use more of a wide window's width (70%/74% caps raised to 84%/88%, still leaving room for the hover-actions gutter), instead of leaving a quarter to a third of a long message's row empty.
- Every run's system instructions now state the current date and time (UTC), so bots judge deadlines, recency and scheduling from the real present instead of guessing it from training data or quoted timestamps.
- Connect Slack, WhatsApp Business Cloud, or Telegram DMs to a bot from Messaging settings, alongside iMessage/SMS. Each app can use a different bot. Group conversations remain iMessage-only.
- Model picker includes Grok 4.6 (xAI) and Ox Alpha Free / GLM-5.3 (OpenCode Go).

### Added

- Bot computer homes can live in any S3-compatible bucket instead of only on the server's disk: set `OBJECT_STORAGE_BUCKET` and its connection settings on the API and worker. Homes are encrypted on the server before upload with a per-home key, each saved revision is a single object, and deleting a bot or space makes its stored home unreadable at once. `home-storage migrate` uploads existing homes and verifies each one. Without the setting, homes stay under `DATA_DIR` as before ([self-hosting](docs/self-host-storage.md#bot-homes-in-object-storage)).
- Stdio MCP servers can connect with OAuth from the MCP servers settings. Rakazo runs the authorization against the provider you name (for example Google), stores the grant encrypted, refreshes it, and passes it to the process through environment variables (`{{oauth.access_token}}` and similar references) or through credential files written to a private temporary directory, so packages that expect a browser login or a token file run unattended. Any client can also limit the scopes it requests.
- Stdio MCP servers can be given environment variables when added in **MCP servers**, under **Advanced**. Values are stored encrypted, like the other server credentials, so API keys a local server reads from its environment no longer have to be pasted into a chat. The form's secret fields no longer invite the browser to fill in a saved password.
- Honcho memory can read an existing Honcho user peer. After entering the workspace another Honcho app already uses, a Space can name that app's user peer under User peer, and recall then includes what Honcho already knows about the user. Rakazo only reads that peer through Honcho's chat; it never creates it or writes conclusions to it.
- Remote MCP servers whose OAuth provider does not offer dynamic client registration can now be connected: enter a client you created in the provider's console under **Advanced** when adding the server, and allow the **Redirect URI** shown there. The client is stored encrypted, its secret is never returned, and it survives **Disconnect**; switching to a different client drops the current grant.
- The web app installs as a PWA on phones: Android Chrome offers a real install prompt, the app shell and its assets are cached so an installed app opens offline (showing its reconnecting state), and a new deploy takes over on the next launch or reload. On iOS the installed app runs full screen and keeps content clear of the notch and home indicator, and the installed app no longer zooms on pinch, double tap or input focus (browser tabs still zoom). Electron and dev builds never register the service worker, and API, RPC and screen traffic always go to the server.
- Self-hosted deployments can run multiple Telegram bots, for example one per space, using `TELEGRAM_BOT_TOKEN_<NAME>` and `TELEGRAM_WEBHOOK_SECRET_TOKEN_<NAME>` pairs.
- Railway computers can start in a chosen region. Set `RAILWAY_SANDBOX_REGION` to keep them near the API instead of Railway's default region, so each command, click, and screenshot avoids a cross-region round trip. Unset, nothing changes.
- A ```mermaid block in a bot's message is drawn as a diagram, on the web, in the desktop app and on mobile, in the app's light or dark palette. Source Mermaid cannot draw stays a code block, and a block the bot is still writing reads as code until it is complete. On the web, Mermaid loads only when a message contains a diagram, and a diagram's source can be copied. The mobile app draws diagrams with Mermaid served by your own server (`/api/v1/assets/mermaid.js`), so an older server keeps showing code blocks.
- A routine can run on its own model and thinking level, picked in the routine editor. Left on the bot's model, nothing changes. A run keeps the model chosen when it was created, so editing the routine afterwards cannot move a waiting run, and a later resume does not treat the model an attempt recorded as that choice. Webhook, GitHub, and message deliveries use a routine model when every routine in that delivery chose the same one, including when the delivery has to wait for the bot to finish.
- The deployment-wide default model can run on Amazon Bedrock without a key. With `PI_DEFAULT_CREDENTIALS=host`, `PI_DEFAULT_PROVIDER=amazon-bedrock` and `PI_DEFAULT_MODEL` set, a deployment whose host has an AWS role (an ECS task, IRSA or EC2 instance role) counts as having a default model, and runs use those credentials instead of a stored Bedrock API key.
- Self-hosted servers can have long replies read aloud as a short summary written by the bot's own model. Off unless `VOICE_SUMMARY_MIN_CHARS` is set; the chat keeps the full reply.
- Voice mode: spoken replies, hold-to-talk dictation, and half-duplex calls with ElevenLabs, OpenAI, Cartesia, or Fish Audio.
- Desktop owners using Docker can opt into running bot shell commands directly on their computer. This grants access under the owner's OS account; see [computer providers](docs/self-host-sandbox-providers.md#choosing-a-provider).
- GitHub Copilot and SuperGrok / X Premium sign-in for model access.
- Spawn peer bots (each with its own thread and computer) and short-lived in-thread subagents.
- ChatGPT Plus or Pro sign-in for model access.
- Mobile: point the app at a self-hosted API origin, a native iOS inbox, and take control of the live desktop.
- Provider-neutral integrations: managed apps through Composio or Pipedream Connect, plus encrypted user-installed Treg, HTTPS MCP, and OpenAPI tool sources on web and mobile.
- Disconnect connected Composio plugins.
- Routines in plain language instead of raw cron.

### Removed

- Nonfunctional Grant folder picker in the desktop app.

### Self-host upgrade notes

- Back up Postgres and `DATA_DIR` before upgrading, and store `ENCRYPTION_KEY` (and `ENCRYPTION_MASTER_KEYS`, if set) apart from them. New messages, events, memory and files are encrypted at rest with keys derived from them, and that content cannot be read without them. To roll back to an earlier release, first run `content-encryption decrypt` ([content encryption](docs/content-encryption.md#rollout)).
- Content written before this release stays in plaintext until you run `content-encryption migrate` ([content encryption](docs/self-host-storage.md#content-encryption)); new content is encrypted from the first start. Set the new `CONTENT_ENCRYPTION=off` to store content readable instead: existing ciphertext still reads, and `content-encryption decrypt` converts it. Compose, published images and Railway default to `on`; the desktop app's **This computer** stack and local development default to `off`.
- The API and worker connect as a separate database login, `rakazo_app`, whose password is `POSTGRES_APP_PASSWORD` in `.env`. `install-images.sh`, the updater, the desktop app and `deploy-main.sh` add it when it is missing. If you upgrade a source checkout (`docker-compose.yml`) or run the production Compose commands by hand, first run `echo "POSTGRES_APP_PASSWORD=$(openssl rand -hex 16)" >> .env`. Otherwise Compose stops with `Set POSTGRES_APP_PASSWORD in .env`.
- The API and worker containers receive only the settings they read, not the whole `.env`. A setting whose name you choose, such as `TELEGRAM_BOT_TOKEN_<NAME>`, needs an [override file](docs/self-host-configuration.md#settings-with-names-you-choose). `install-images.sh` names every `.env` setting that no container receives, and layers `docker-compose.override.yml` when it is present.
- Unless `SANDBOX_COMPUTER_EGRESS` is set, Docker computers use restricted egress when the host firewall rules are installed, and open egress as before when they are not ([restricted computer egress](docs/self-host-docker-computers.md#restricted-computer-egress)).
- Only the deployment owner can use an OpenAI-compatible model or voice server on a private address, such as a LAN Ollama, `host.docker.internal` or a host listed in `RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS`. Other users' runs on such a connection fail with "Private model endpoints are limited to the deployment owner." Set `MCP_ALLOW_PRIVATE_ENDPOINT=true` to allow them for every user, or serve the models to everyone with `RAKAZO_LOCAL_MODELS`.
- A bot asks before fetching a site that it was not given in the run. This includes routines. Choose **Always allow** on the approval card or turn on Auto Review. Webhook runs refuse such sites.
- The web app sends a strict Content-Security-Policy, which blocks scripts that a CDN or proxy injects. Search the API logs for `csp.violation` and add the origins with `RAKAZO_CSP_SCRIPT_SRC` and `RAKAZO_CSP_CONNECT_SRC`.
- Mobile app users need to sign in again once.

### Messaging upgrade notes

- Webhooks use `/api/v1/messaging/webhook/<provider>`; the previous Sendblue path remains supported.
- Configure credentials for each messaging provider in `.env`; see [.env.example](.env.example).
- Unknown senders are ignored by default. `MESSAGING_OPEN_SIGNUP=true` restores automatic account
  creation from incoming messages and requires a deployment model key.

## [0.1.0-beta] - 2026-08-13

Initial public beta: web, Electron, and Expo clients; Pi runtime; Docker and E2B computers; plugins; one thread, computer, memory, routines, and history per bot.
