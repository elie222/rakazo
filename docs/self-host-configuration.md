# Configuration

Rakazo reads its settings from environment variables, normally kept in the `.env` file next to
the Compose file.

## Where settings live

Each service reads its settings when it starts, so restart the services that read a setting after
changing it. `.env.example` (source checkout) and `.env.images.example` (published images) list the
common ones with short notes.

Do not commit `.env`. Never put `COMPOSIO_API_KEY`, OpenRouter keys, or provider tokens in git, logs, or chat.

## Settings with names you choose

The Compose files pass the API and worker only the settings each one reads, listed by name, rather than the whole `.env`. A setting whose name you choose, such as `TELEGRAM_BOT_TOKEN_<NAME>`, therefore needs its own line: add it under `api` and `worker` `environment` in an override file layered after the base file (and in `RAKAZO_COMPOSE_FILE` when the updater is enabled), with no value so Compose fills it from `.env`. `install-images.sh` names any `.env` setting that no container receives.

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
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SANDBOX_PROVIDER=docker   # or none, e2b, novita, daytona, createos, boat. Keep fake only for pnpm test.
AGENT_RUNTIME=pi          # Keep scripted only for pnpm test.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause or stop after 10 minutes idle; 0 disables idle sleep
# Set 0 when self-hosting with Docker, where an idle computer costs nothing, to keep long-running apps and sessions up.
# E2B, CreateOS and Boat still apply their own timeouts.
COMPUTER_MAX_ACTIVE_MS=7200000 # uptime cap for providers that bill while running; minimum 60000; 0 disables
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes
MAX_TOOL_CALLS_PER_TURN=  # optional Pi turn tool-call fuse; unset/0 = unlimited
RAKAZO_MESSAGE_USER_MAX_CHARS=500 # message_user length cap; narration stays at 500
BOT_MESSAGE_MAX_HOPS=6    # bot-to-bot messages one chain may carry before the next is refused
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
NOVITA_API_KEY=           # when SANDBOX_PROVIDER=novita; build its template first
DAYTONA_API_KEY=          # when SANDBOX_PROVIDER=daytona
CREATEOS_SANDBOX_API_KEY= # when SANDBOX_PROVIDER=createos
BOAT_API_KEY=             # when SANDBOX_PROVIDER=boat
```

`COMPUTER_TAKEOVER_TTL_MS` (default `900000`, 15 minutes) is how long a person's takeover of a bot's
screen lasts before control expires.

`MODEL_STREAM_MAX_RETRIES` (0 to 5, default `1`) retries a model stream that fails partway; more
retries let long turns survive brief provider failures.

## Feature switches

| Variable | Default | Effect |
| --- | --- | --- |
| `TICKET_BOARD_ENABLED` | `false` | Turns on the ticket board. Set it on the API and worker. |
| `USER_DEVICES_ENABLED` | on | `false` stops signed-in desktop apps from letting bots run commands on the user's own computer. Set it on the API and worker. |
| `PI_SESSION_RECORDING` | off | `true` records agent sessions as JSONL under `DATA_DIR/pi-sessions`. The files are not encrypted, so do not use it on a shared or multi-tenant install. |
| `PRIVACY_POLICY_URL` | Rakazo's policy | The privacy policy linked from the AI data-sharing notice. Set it on the API. |

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
the messaging outbox drain and webhooks run in a named system scope (`runAsSystem` in
`packages/db`). The job queue's tables (`graphile_worker`) hold job metadata, not Space content:
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
