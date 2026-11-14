# Configuration

Rakazo reads its settings from environment variables, normally kept in the `.env` file next to
the Compose file.

## Where settings live

Each service reads its settings when it starts, so restart the services that read a setting after
changing it. `.env.example` (source checkout) and `.env.images.example` (published images) list the
common ones with short notes.

Do not commit `.env`. Never put `COMPOSIO_API_KEY`, OpenRouter keys, or provider tokens in git, logs, or chat.

## Settings with names you choose

The Compose files pass the API and worker only the settings each one reads, listed by name, rather than the whole `.env`. A setting whose name you choose, such as `TELEGRAM_BOT_TOKEN_<NAME>` or `PHOTON_PROJECT_ID_<NAME>`, therefore needs its own line: add it under `api` and `worker` `environment` in an override file layered after the base file (and in `RAKAZO_COMPOSE_FILE` when the updater is enabled), with no value so Compose fills it from `.env`. `install-images.sh` names any `.env` setting that no container receives.

```yaml
# docker-compose.override.yml
services:
  api:
    environment:
      TELEGRAM_BOT_TOKEN_SUPPORT:
      TELEGRAM_WEBHOOK_SECRET_TOKEN_SUPPORT:
  worker:
    environment:
      TELEGRAM_BOT_TOKEN_SUPPORT:
      TELEGRAM_WEBHOOK_SECRET_TOKEN_SUPPORT:
```

`install-images.sh` layers a `docker-compose.override.yml` next to it automatically. In your own
commands, add `-f docker-compose.override.yml` after the base file.

## Core settings

All of these are optional:

```env
RAKAZO_EXTRA_AUTH_ORIGINS=   # extra origins allowed to sign in and call the API; see below
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SCIM_BEARER_TOKEN=        # lets your identity provider add and remove accounts; see self-host-accounts.md
SANDBOX_PROVIDER=docker   # or none, e2b, novita, daytona, createos, boat. Keep fake only for pnpm test.
AGENT_RUNTIME=pi          # Keep scripted only for pnpm test.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause or stop after 10 minutes idle; 0 disables idle sleep
# Set 0 when self-hosting with Docker, where an idle computer costs nothing, to keep long-running apps and sessions up.
# E2B, CreateOS and Boat still apply their own timeouts.
COMPUTER_MAX_ACTIVE_MS=7200000 # uptime cap for providers that bill while running; minimum 60000; 0 disables
COMPUTER_MAX_ACTIVE_UNBILLED_MS=0 # uptime cap for providers that do not bill while running (Docker, Kubernetes, Incus); minimum 60000; 0 (default) disables; needs SANDBOX_IDLE_MS on
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes
MAX_TOOL_CALLS_PER_TURN=  # optional Pi turn tool-call fuse; unset/0 = unlimited
RAKAZO_MESSAGE_USER_MAX_CHARS=500 # message_user length cap; narration stays at 500
RAKAZO_OPENING_ACKNOWLEDGEMENT=  # 1: chat-mode bots post an opening sentence at once and show short step statuses as the working line
BOT_MESSAGE_MAX_HOPS=6    # bot-to-bot messages one chain may carry before the next is refused
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
NOVITA_API_KEY=           # when SANDBOX_PROVIDER=novita; build its template first
DAYTONA_API_KEY=          # when SANDBOX_PROVIDER=daytona
CREATEOS_SANDBOX_API_KEY= # when SANDBOX_PROVIDER=createos
BOAT_API_KEY=             # when SANDBOX_PROVIDER=boat
```

`STUCK_WORK_NOTIFY_AFTER_MS` (default `14400000`, 4 hours) is how long a queued run or an unanswered
question may sit before the worker sends a "still waiting" reminder. `STUCK_WORK_EXPIRE_AFTER_MS`
(default `86400000`, 24 hours) is how long before the worker stops it, leaves a status line in the
thread, and frees the bot's computer. Both take milliseconds from `60000` to `2592000000` (30 days);
anything else keeps the default. Setting the expiry below the reminder time skips the reminder. A
takeover request nobody acts on still stops after 30 minutes. The activity list keeps marking old
queued runs after 4 hours.

`MODEL_STREAM_MAX_RETRIES` (0 to 5, default `1`) retries a model stream that fails partway; more
retries let long turns survive brief provider failures.

Model timeouts are configurable in milliseconds. Invalid or out-of-range values retain their
defaults. Longer timeouts can help when several bots share a local inference server that queues
requests. For `RAKAZO_LOCAL_MODELS` servers and compatible model connections added in the app,
these settings are the only limits Rakazo applies, and a stream that is cut off names why in the
run's error details, such as `terminated (other side closed)`. Built-in providers still drop a
response after 5 minutes without data, and a proxy or load balancer in between may cut off a
silent stream sooner.

- `MODEL_STREAM_TIMEOUT_MS` (default `120000`, range `1000`–`2147483647`) is the time budget
  for retrying the same model. It also controls the wait for response headers when using the
  OpenAI Chat Completions, Responses or Codex API, Anthropic Messages, Mistral or Azure OpenAI.
  Other APIs, such as Google, Vertex AI, Bedrock and some routed models, use their own client
  timeouts.
- `MODEL_STREAM_IDLE_TIMEOUT_MS` (default `180000`, range `0`–`2147483647`) bounds how long
  a started response may remain silent. Set it to `0` to disable Rakazo's inactivity watchdog.
  Explicit request cancellation remains available. Disabling this protection can leave stalled
  requests waiting indefinitely if neither the provider nor the caller terminates them.
- `MODEL_CONNECT_TIMEOUT_MS` (default `30000`, range `1000`–`300000`) bounds connecting to an
  OpenAI-compatible model or speech connection added in the app. `RAKAZO_LOCAL_MODELS` servers
  and built-in providers retain Node's own connection timeout.

### Reaching Rakazo from a second address

Sign-in and API calls are accepted only from `WEB_ORIGIN`, `API_URL`, `BETTER_AUTH_URL` and the
mobile app. If you also open the same install from another address, such as a Tailscale name or a
LAN IP, the browser or desktop app gets `403 INVALID_ORIGIN`. List that address in
`RAKAZO_EXTRA_AUTH_ORIGINS`, comma-separated:

```env
RAKAZO_EXTRA_AUTH_ORIGINS=https://rakazo.your-tailnet.ts.net,http://192.168.1.20:5173
```

Each entry must be a bare origin (scheme, host, optional port; no path). `https://` is accepted for
any host. `http://` is accepted only for loopback, `.local`, and private-network IPs (RFC 1918 and
Tailscale's 100.64.0.0/10). Anything else is ignored and logged as a warning. Only origins you list
are trusted; the default is none. `WEB_ORIGIN` stays the address used in links, passkeys and OAuth
callbacks.

## Feature switches

| Variable               | Default         | Effect                                                                                                                                                  |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TICKET_BOARD_ENABLED` | `false`         | Turns on the ticket board. Set it on the API and worker.                                                                                                |
| `USER_DEVICES_ENABLED` | on              | `false` stops signed-in desktop apps from letting bots run commands on the user's own computer. Set it on the API and worker.                           |
| `PI_SESSION_RECORDING` | off             | `true` records agent sessions as JSONL under `DATA_DIR/pi-sessions`. The files are not encrypted, so do not use it on a shared or multi-tenant install. |
| `PRIVACY_POLICY_URL`   | Rakazo's policy | The privacy policy linked from the AI data-sharing notice. Set it on the API.                                                                           |

## Database roles

Rakazo uses two Postgres logins:

- The owner (`POSTGRES_USER`, or `DATABASE_MIGRATION_URL` outside Compose) runs migrations and
  owns the tables.
- The app login (`rakazo_app` with `POSTGRES_APP_PASSWORD`, or `DATABASE_URL`) is not a
  superuser, cannot bypass row-level security, cannot create objects, and can only read and write
  the app tables.

`pnpm db:migrate` (in containers, its prebuilt form `pnpm --filter @rakazo/api db:deploy`, which the
one-shot `migrate` container runs before the API starts) applies the migrations and the job queue
schema as the owner. Only that container gets the owner login, so code running in the API or
worker cannot find one that bypasses row-level security. It then creates the app login named in `DATABASE_URL`, or updates its
password, and grants it the `rakazo_app` role. When migrations run as a role without
`CREATEROLE`, as on some managed Postgres, create the login yourself and
`GRANT rakazo_app TO <login>`.

Messages, events, threads, memory, artifacts, secrets, model and voice credentials, skills, bots,
runs, tasks, routines, connections, MCP servers and sign-ins, computers, boards and tickets,
messaging identities and outbox, external conversations, steering messages, usage, scratchpad
items and approval rules have row-level security. Each signed-in request sees only its Space's
rows, plus the user's own account-level credentials. A query that leaves out its Space filter
returns nothing from other Spaces. A background job that acts for one run, routine, computer,
skill, thread or cloud agent runs as that row's Space and user, so agent tools get the same
backstop. Security events are written and read only in system scope. Reconcilers, queue sweeps,
chat delivery and webhooks run in a named system scope (`runAsSystem` in
`packages/db`). That scope also sends a key derived from the app login's password, which
`pnpm db:migrate` registers, so SQL that runs for one Space cannot switch itself into system scope.
An app login without a password in `DATABASE_URL` has no key, and `pnpm db:migrate` warns. The job queue's tables (`graphile_worker`) hold job metadata, not Space content:
graphile-worker turns on row-level security for them, and `pnpm db:migrate` adds a policy that
gives the app login every row.

With only `DATABASE_URL` set, migrations and the app share one login. Everything keeps working,
but `pnpm db:migrate`, the API and the worker warn that row-level security is not enforced. To fix
this, set `DATABASE_MIGRATION_URL` to the owner and `DATABASE_URL` to a new login.

Run `pg_dump` as the owner. The app login would only dump rows it is allowed to see.

## Database connections

The API keeps a pool of 4 Postgres connections and the worker a pool of 8. `DB_POOL_MAX` sets both
to the same value, so size it for the worker: Graphile Worker needs at least 6, and the worker also
holds three listening connections and a leadership connection.

`REALTIME_DATABASE_URL` sends the long-lived `LISTEN` connections that carry live updates to a
different address than `DATABASE_URL`, for example a direct connection when `DATABASE_URL` goes
through a transaction pooler. It defaults to `DATABASE_URL`.

`GRAPHILE_WORKER_CONCURRENCY` (default `4`) caps concurrent deliveries from the older interactive
job queue during rolling upgrades. New agent runs dispatch straight from Postgres and do not take
those slots.

## API and worker memory

Chat runs execute in the API container that receives the message, and routines and other
background runs execute in the worker, so both hold live agent turns. In the production Compose
file, `RAKAZO_API_MEMORY_LIMIT` and `RAKAZO_WORKER_MEMORY_LIMIT` cap them (Compose sizes such as
`2g` or `3072m`, default `2g` each). Raise them on a larger host. Deploys briefly run the old and
new container of each side by side, so leave room for both.

## More API and worker containers

Each API and worker container runs on about one CPU core. On a host with more cores,
`RAKAZO_API_REPLICAS` and `RAKAZO_WORKER_REPLICAS` (default `1` each) run several; they share work
through Postgres and Caddy spreads requests across the API containers. The deploy script applies a
new count on its next run, starting that many new containers before it stops the old ones, so
leave memory for twice the count during a deploy. With more than one API container, give Telegram
bots and iMessage projects a webhook secret: without one each API polls for the same messages.

A deploy also briefly needs twice the database connections. Each API and worker container holds up
to `DB_POOL_MAX` connections plus a few for live updates, and Postgres allows 100 in all by default;
when twice the containers' total comes near that, run `ALTER SYSTEM SET max_connections = 200;` as
the owner (`POSTGRES_USER`) and restart Postgres. Otherwise a deploy fails some requests with
"too many clients".

## Postgres memory

The production Compose file sizes Postgres for an 8 GB host: `POSTGRES_MEMORY_LIMIT` caps the
container (default `2560m`), `POSTGRES_SHARED_BUFFERS` sets its cache (default `1GB`, which counts
against that cap) and `POSTGRES_EFFECTIVE_CACHE_SIZE` tells the planner how much data stays cached
(default `2GB`). On a smaller host, lower them along with the API and worker caps above. Changing
them restarts Postgres.

## Listening addresses

The API listens on `API_HOST` (default `127.0.0.1`) and `API_PORT` (default `3100`). Keep loopback
unless a container or a trusted reverse proxy must reach it; the Compose files set this for you.
The published-images stack publishes the web app on `127.0.0.1:5173` and the API on
`127.0.0.1:3100`; set `RAKAZO_WEB_PORT` or `RAKAZO_API_PORT` to use other host ports.
For LAN access, set `RAKAZO_WEB_BIND` as described in
[Connecting a phone on the same network](./self-host-clients.md#connecting-a-phone-on-the-same-network).

## Outbound proxy

To send the API and worker's outbound traffic through a corporate proxy, set `HTTP_PROXY`,
`HTTPS_PROXY` and `NO_PROXY` (either case works) in `.env`. List the stack's own service names in
`NO_PROXY` so internal traffic skips the proxy:

```env
HTTPS_PROXY=http://proxy.example.com:3128
NO_PROXY=localhost,127.0.0.1,postgres,supervisor,api,worker,web
```

For mirrors of the installer and images, see [restricted networks](./self-host-restricted-network.md).
