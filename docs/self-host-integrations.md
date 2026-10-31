# Tools and integrations

Configure the services bots reach beyond the model: web search, memory, MCP servers, apps,
messaging, cloud coding agents and payments.

## Web search and page reading

Builtin `web_search` and `web_fetch` use keyless HTTP search (DuckDuckGo HTML) and local
Readability extraction by default. To choose [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp),
set `WEB_PROVIDER=parallel` in `.env` and restart both the API and worker. The same bot tools
then return search excerpts and extracted page markdown through HTTPS MCP at
`https://search.parallel.ai/mcp`. Search uses Fast mode without an account or API key.

This option sends search queries and requested page URLs to Parallel, which retrieves pages
on its servers. Conversation accounting uses an HMAC of internal IDs keyed by
`ENCRYPTION_KEY` (shared by the API and worker), so deployments with distinct secrets send
distinct session IDs. Rotating that secret resets the session IDs; the existing development-only
encryption-key fallback also applies here. Anonymous access has service limits; rate-limit and provider errors are returned
to the bot without switching providers. Per-bot disabled web tools remain disabled. Set
`WEB_PROVIDER=keyless-http` (or remove the setting) to return to the default.

To choose [Keenable](https://docs.keenable.ai) instead, set `WEB_PROVIDER=keenable` and restart
both the API and worker. The same bot tools then return search snippets and extracted page
markdown through HTTPS MCP at `https://api.keenable.ai/mcp`, without an account or API key. This
option sends search queries and requested page URLs to Keenable, which retrieves pages on its
servers. Anonymous access is rate limited per IP address; set `KEENABLE_API_KEY` on the API and
worker to send a key and lift those limits. Errors, per-bot disabled tools and the way back to
the default work as described for Parallel.

## Self-hosted memory

Supermemory and Honcho can run on your own network. In **Settings → Memory**, choose **Local**
and enter the instance's base URL. The operator must set `MCP_ALLOW_PRIVATE_ENDPOINT=true`; workspace owners can then save a local endpoint. It must
be loopback or resolve to private addresses (a Compose service name, an RFC1918 or unique-local
address, or a `.internal` name such as Railway's private network); Rakazo pins the resolved
address for every request. Space members use the saved connection without seeing its key.

For [Honcho](https://github.com/plastic-labs/honcho), enable `AUTH_USE_AUTH` on the Honcho
server and use an admin JWT from its `scripts/generate_jwt.py --admin` as the key, so each Space
gets its own workspace. A workspace-scoped JWT works when you enter that workspace. Honcho needs
its own PostgreSQL with pgvector, an LLM provider, and an embedding provider; set
`EMBEDDING_VECTOR_DIMENSIONS` before its first start. Rakazo stores only explicitly saved facts
in Honcho; conversation summaries stay in Rakazo. Bots can forget a saved fact on Honcho v3.2 or
later.

## MCP servers

Remote MCP servers and installed API / GraphQL connectors default to public HTTPS. The deployment
owner can attach one on localhost, the same LAN, or a Docker network. Set
`MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker to allow these for every user. Cloud
metadata addresses stay blocked. Leave the flag unset on public installs.

Remote MCP servers that use OAuth normally register Rakazo with their provider on the first
**Connect OAuth**. Some providers only accept a client you create in their console. For those,
enter the client ID (and secret, for a confidential client) under **Advanced** when adding the
server, and add the **Redirect URI** shown there (`<your web origin>/mcp/oauth/callback`) to the
client's allowed redirect URIs. The client is stored encrypted with the server's other
credentials and survives **Disconnect**; switching to a different client drops the current grant.
On first use the client is bound to the authorization server the MCP server pointed to, and Rakazo
refuses to send it anywhere else afterwards. Replacing the client clears the binding.

Stdio MCP servers can use OAuth too. They do not authorize themselves (the MCP spec has them
read credentials from the environment), so Rakazo runs the flow for them. They are off unless
the API and worker have `MCP_STDIO_ENABLED=true` and the command is listed in
`MCP_STDIO_ALLOWED_COMMANDS`. A stdio server runs inside the API and worker with their access,
so only admins (verified accounts listed in `RAKAZO_ADMIN_EMAILS`) can add or edit one, in
**Settings** or through an agent import; with no admins listed, nobody can. Bots never add stdio servers. Everyone can still add remote servers, and a
stdio server an admin added keeps working for everyone it is available to. When adding the
server, enter the OAuth client, its
**Authorization server** (the issuer, for example `https://accounts.google.com`) and the
**Scopes**, then click **Connect OAuth** as for a remote server. Some providers issue a refresh
token only when asked through extra parameters: for Google, set **Authorization parameters** to
`access_type=offline&prompt=consent`. Pass the grant to the process
through its environment variables:

- A value can reference `{{oauth.access_token}}`, `{{oauth.refresh_token}}`,
  `{{oauth.client_id}}`, `{{oauth.client_secret}}`, `{{oauth.expires_at}}` (epoch milliseconds),
  `{{oauth.scope}}` or `{{oauth.token_type}}`, alone or inside other text.
- A variable can be a **File** instead: its template (often JSON, with the same references) is
  written to a private temporary directory when the process starts, and the variable receives
  the file's path. Use this for packages that read a credentials or token file path.

Rakazo refreshes the grant and restarts the process shortly before an access token it passed
expires, so a long-running process never keeps a dead token. A process that only receives the
refresh token refreshes on its own. Temporary files are removed when the process stops.

A server launched as `npx [-y] <package>[@version]` (or `npx -p <package> <bin>`) is not
downloaded on every start. Rakazo installs the package once, without running its install
scripts, with `npm install` into
`MCP_PACKAGES_DIR` (default `DATA_DIR/mcp-packages`, shared by the API and worker), then runs
its bin directly; `npx` must still be in `MCP_STDIO_ALLOWED_COMMANDS`. The install has its own
timeout, `MCP_STDIO_INSTALL_TIMEOUT_MS` (default 180000), separate from the handshake timeout
`MCP_STDIO_STARTUP_TIMEOUT_MS` (default 30000). Pin a version so every start runs the same
code; npm settings such as `NPM_CONFIG_REGISTRY` can be set in the server's environment
variables. Any other `npx` form (local paths, git and tarball URLs, unknown `npx` flags) is
refused. `npx` is the only supported package launcher: other package managers and runners
(`npm`, `pnpm`, `yarn`, `bun`, `bunx`, `deno`, `uv`, `uvx`, `pipx` and the like) are refused
even when allowlisted. To run a server from another ecosystem, install it on the host and
allowlist its binary. An allowlisted interpreter or shell (`node`, `python`, `sh`) runs any
code passed in its arguments, so allowlist it only where that is acceptable. Each server runs as one process per user in each of the API and worker,
shared by that user's bots, and stops after `MCP_STDIO_IDLE_MS` (default 900000, 15 minutes)
without use. When a server fails to start, the reason (including the end of its stderr, with
credentials redacted) appears on the server in **Settings**, and its bots are told it is
unavailable instead of silently losing its tools.

A run never waits long on one server. It gives each server `MCP_DISCOVERY_TIMEOUT_MS` (default
20000) to list its tools, then goes on without it; a package still installing finishes in the
background and its tools appear on a later turn. After a failure, runs skip that server for 30
seconds, doubling up to 5 minutes while it keeps failing. A successful **Test connection** or
discovery, or a change to the server's settings, ends the wait at once.

If a server shows its tools in **Settings** but a bot never uses them, run the
[diagnostics report](./self-host.md#reporting-a-problem). Its **Assignment** column names any
space or owner mismatch that keeps the server's tools from that bot.

## Apps and connectors

Plugins use [Composio](https://composio.dev) when `COMPOSIO_API_KEY` is set. Pipedream is an
alternative managed connector provider: set `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`,
`PIPEDREAM_PROJECT_ID` and `PIPEDREAM_ENVIRONMENT` (`development` or `production`). Set them on the
API and worker.

`INTEGRATIONS_CATALOG_URL` points API connector search at an
[integrations.sh](https://integrations.sh/)-compatible catalog, such as a mirror you host. Give the
base URL; Rakazo appends `api/search`.

## Messaging apps

Optional messaging platforms (iMessage through Sendblue or Photon, Slack, WhatsApp, Telegram, Feishu/Lark) mount when their env credentials are set — see `.env.example`. The Lark adapter and official SDK load only when configured. Point a Feishu/Lark bot event subscription at `/api/v1/messaging/webhook/lark` (webhook/HTTP inbound only; do not enable long connection). Personal group linking stays iMessage-only; Slack channels use workspace installations below. Telegram can run several bots side by side (`TELEGRAM_BOT_TOKEN_<NAME>` plus `TELEGRAM_WEBHOOK_SECRET_TOKEN_<NAME>`), for example one per space, so the same person can chat with a different Rakazo bot through each. Photon receives iMessage over an outbound stream from the API, so it works on a server with no public URL; on Photon's shared lines the person texts first, and group chats are not available.

Each platform turns on when its full set of credentials is present on the API and worker.
Webhooks arrive at `/api/v1/messaging/webhook/<provider>`.

| Platform | Settings |
| --- | --- |
| iMessage and SMS (Sendblue) | `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET`, `SENDBLUE_SIGNING_SECRET`, `SENDBLUE_PHONE_NUMBER` |
| WhatsApp Business Cloud | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN` |
| iMessage (Photon) | `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`; `PHOTON_WEBHOOK_SECRET` to receive by webhook instead of the stream |
| Feishu/Lark | `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_VERIFICATION_TOKEN`; `LARK_ENCRYPT_KEY` when event encryption is on; `LARK_DOMAIN` (`feishu`, the default, or `lark`) |
| Slack | See below |

Telegram is webhook-only: Telegram sends the secret in `X-Telegram-Bot-Api-Secret-Token`, and the
worker never long-polls. An extra bot named `<NAME>` (letters and digits) uses the provider
`telegram-<name>` and the webhook `/api/v1/messaging/webhook/telegram-<name>`; see
[settings with names you choose](./self-host-configuration.md#settings-with-names-you-choose). For
Lark, create a custom app with the Bot capability and subscribe it to `im.message.receive_v1`.

People link a chat app to their account from **Messaging** settings. `MESSAGING_OPEN_SIGNUP=true`
instead gives unknown senders their own chat-only accounts, whose runs use the deployment model.

In rooms, a bot decides whether to answer ambient messages with its own model. To use a separate
model for that decision, set both `TEAM_CHAT_JUDGE_PROVIDER` and `TEAM_CHAT_JUDGE_MODEL`.

### Slack

For Slack workspace installations, set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and
`SLACK_SIGNING_SECRET` on the API and worker. Register the OAuth redirect URL
`https://app.example.com/api/v1/messaging/install/slack/callback` using your public
API origin (`API_URL`). Enable distribution in the Slack app's Manage Distribution
settings so other workspaces can install it. Enable Slack Events API delivery to
`https://app.example.com/api/v1/messaging/webhook/slack`, with `app_mention`,
`message.im`, `message.channels`, `message.groups`, `message.mpim`, and
`app_uninstalled`. Enable the app's Messages tab. The install flow requests the
message/history, channel/user lookup, file read and write, and reaction-write scopes it uses;
reinstall the Slack app after changing scopes. Socket Mode is not used.

In Messaging settings, select **Connect** on the Slack row. The workspace answers as
the first bot in your default space, whichever space is open. Each Slack workspace
belongs to one Rakazo space and one installation owner; installing it from another
space is rejected. To DM that bot, use **Link DMs** and send the code in a DM to the
Slack app. Teammates in the same space can link their own bots the same way.
Invite the Slack app to channels and mention it to receive replies there. The
bot's external conversations offer **Mentions only**, **Listen**, and room guidance.
Workspace setup and personal linking are available on web, desktop and mobile.
Mobile opens Slack authorization in the system browser; return to the app when it
finishes. Channel listening settings currently live in the web/desktop interface.

Tokens are encrypted with the configured secret store. Workers resolve the
installation for every outbound operation, including queued replies; disconnecting
an installation stops further delivery and unlinks its personal DMs. Slack's signed
`app_uninstalled` event also removes the installation. Disconnect removes Rakazo's
local credentials; remove the app in Slack to revoke Slack's installation itself.
The installation owner must retain space membership and an active bot. Workspace
installations require a workspace-level bot token without Slack token rotation;
Enterprise Grid org-wide installs and rotating tokens are rejected explicitly.

The older `SLACK_BOT_TOKEN` plus `SLACK_SIGNING_SECRET` configuration still supports
a single workspace. OAuth mode takes precedence when configured; existing static
Slack identities/conversations must be relinked before using workspace installs.
`TEAM_CHAT_BOT_ID` only selects a channel bot for the static configuration. It does
not override workspace installations or personal DMs. Slack tools authorized from
the Integrations screen are a separate connection from this messaging surface.

## Cloud coding agents

Cloud agents delegate a repository task to a hosted coding agent and track its result in the bot's chat. They are separate from the bot computer and its in-turn subagents. Web, Electron, and mobile show the same status and pull-request link.

The default is `CLOUD_AGENT_PROVIDER=none`. Core workflows do not require Cursor or any other hosted coding provider.

### Enable Cursor

Configure the API and worker with the same values:

```dotenv
CLOUD_AGENT_PROVIDER=cursor
CLOUD_AGENT_SPACE_ID=example-space-id
CURSOR_API_KEY=replace-with-your-key
```

The key and explicit Space ID are both required. Use a credential whose connected repositories may be accessed by members of that Space. Each created agent is additionally bound to its initiating user; another user cannot inspect, reply to, or cancel it by supplying an agent ID. The deployment key is never a model tool argument.

The tools are `cloud_agent_launch`, `cloud_agent_status`, `cloud_agent_reply`, and `cloud_agent_cancel`. All three mutations participate in the existing action-approval rules and auto-review policy. As with other consequential tools, an empty rule set and disabled auto-review permit execution by default.

Launch accepts a prompt, optional repository, images, and `openPr`. Raw environment variables are intentionally unsupported: passing secrets through model-generated tool arguments would persist them in ordinary history. Configure remote environment secrets directly with the provider.

### Recovery

The database stores ownership and pending operations independently of chat cards. The worker and reconciler recover queue failures and interrupted launches. Cursor creates use a stable client agent ID, so retrying an accepted create does not create another remote agent.

Each follow-up tracks its own remote run. When a follow-up response is lost, the worker observes the latest run instead of resending the prompt. Until it can distinguish the new run, status remains pending; it does not claim the older run completed the follow-up. Cancellation likewise remains pending until the remote state confirms it. If a request's outcome remains unknown indefinitely, inspect the agent on the provider's site.

Clearing a chat, deleting or archiving its bot, or removing the owner's Space membership causes pending remote work to be cancelled on the next reconciliation. Clearing a chat does not erase ownership or recreate the removed card. Terminal notifications are deduplicated in the durable record.

The stored credential binding fails closed if the key or provider changes. Cancel or finish active agents before rotating credentials, changing the authorized Space, or disabling the provider. If changed prematurely, restore the previous configuration to reconcile those agents, or stop them directly with the provider. No existing agent is silently routed through a replacement credential.

### Offline verification

`CLOUD_AGENT_PROVIDER=emulator` runs the real Cursor adapter against an in-process Cursor HTTP emulator for development and web E2E. It is not durable across separate processes.

The emulator models run creation, unknown run statuses, archived or expired agents, removed agents and runs, rejected keys, and rate limits without network calls. The conformance suite runs against it, and `pnpm test:integration` exercises the database lifecycle against the Cursor emulator: lost responses, stale run metadata, queue outages, ownership boundaries, cleared chats, worker restart, overlapping polls, and cancellation races.

## Payments

Bots can buy things with their user's wallet. Each user connects their own wallet, and every purchase asks them to approve it in the wallet provider's app or page before any card or token exists. Card numbers, security codes and payment tokens go straight to the merchant; they never reach the model, chat history, tool results, or logs.

The default is `PAYMENT_WALLET_PROVIDER=none`. Core workflows do not require a wallet, and with none configured users see nothing related to payments.

### Enable Link

Configure the API and worker with the same values:

```dotenv
PAYMENT_WALLET_PROVIDER=link
# Optional. Defaults to Link's public sign-in client.
PAYMENT_WALLET_CLIENT_ID=
```

Users then see a Link connect button in Settings. Connecting opens Link's sign-in page with a code to confirm. Once connected, bots get `request_purchase`, `purchase_status` and `paid_request`. Each request names the amount and reason; the user approves or denies it in Link.

Link is available to users in the US and Canada only.

Unknown or blank values fall back to `none` instead of failing at boot.

### How a purchase is paid

- **Card.** Approval issues a single-use card. The bot types it into the checkout on the purchase's own HTTPS origin, in the page or in a known payment provider's frame on it.
- **Pay token.** A Stripe checkout that accepts Link pay tokens says so in the page snapshot, with its merchant account. The bot requests the purchase for that account, and after approval hands the token to the checkout, which then shows the user's saved Link card. Tokens expire 30 minutes after approval.
- **Paid HTTP requests.** `paid_request` sends an HTTPS request. If the server answers `402 Payment Required` with a Machine Payments Protocol challenge for Stripe, the amount comes from the challenge and the user approves it; the bot then sends the request again and it carries the payment. Other payment methods are never paid. The request is stored encrypted until it is sent, it may not carry credentials or cookies, and redirects are reported instead of followed. A payment token is used once; a refused paid request needs a new approval.

### Disconnecting

Disconnecting in Settings revokes the connection with the provider. If the provider revokes it first (for example, the user signs out of the connection in Link), purchase tools stop working until the user connects again.

### Offline wallet verification

`PAYMENT_WALLET_PROVIDER=emulator` runs an in-process wallet for development and tests. Sign-in completes immediately; purchases are approved on the next status check, and amounts above 1,000.00 are denied. It fills the test card `4242 4242 4242 4242`, issues fake pay tokens, and pays Stripe challenges in 402 responses with a fake token. A shared conformance suite runs against the emulator and against the Link adapter backed by a fake Link API and a fake paid API, without network calls.
