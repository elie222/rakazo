# Self-hosting Rakazo

Run the API, worker, web app, database and bot computers on a machine you control.
Other self-hosted AI agents are compared on the [self-hosted AI agent](https://rakazo.com/self-hosted-ai-agent/#other-agents) page.

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, Daytona, CreateOS, or Boat). It is not a static site. The marketing site in `apps/www` can be hosted separately.

English | [简体中文](./zh-CN/self-host.md)

## What you need

- A server with 2 vCPUs and 4 GB of RAM. Rakazo itself uses about 1 GB; each running bot computer
  can use up to 2 GB (`RAKAZO_COMPUTER_MEMORY`), so add memory for several busy bots or use a
  remote computer provider.
- Docker Engine 26 or newer with the Compose plugin, curl and OpenSSL. On Linux, running the
  installer as root installs Docker for you. Nothing else is needed for the published images.
- A model: an OpenRouter key, a connection added in the app after signup, or a model server you
  run yourself ([models](./self-host-models.md)).
- For a public host, a domain and TLS ([production deployment](./self-host-production.md)).

## Published images (no checkout)

Pull Postgres and `ghcr.io/elie222/rakazo/app` into any empty folder. No clone or image build.
Requires Docker Engine 26+ (API 1.45+ for bot home volume subpaths), the Compose plugin, curl, and OpenSSL.

```bash
mkdir -p rakazo && cd rakazo &&
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh &&
bash install-images.sh
```

The installer downloads `docker-compose.images.yml` and `.env.images.example`, creates `.env` with
random secrets, then pulls and starts the images. It preserves an existing `.env` when rerun. For
the installer secret list, non-reuse rules, and recovery, see
[Self-host secrets checklist](./self-host-secrets.md). To customize the public URL, image tag, or
optional providers before startup, run `bash install-images.sh --prepare-only`, edit `.env`, then
run `bash install-images.sh`. Flags may be combined in either order: `--prepare-only`, `--local`.
When `RAKAZO_IMAGE_TAG` is a release such as `v0.8.0`, the installer downloads the Compose files
from that release instead of `main`.

`SANDBOX_PROVIDER` defaults to `docker`. The images Compose file runs a sandbox supervisor
(from the app image, on the internal network only) and pulls `ghcr.io/elie222/rakazo/computer`.
Signup and local Docker computers work without an E2B account. Optional remote providers: set
`SANDBOX_PROVIDER` to `e2b`, `novita`, `daytona`, `createos`, or `boat` and add the matching API key. The published-images
Compose stack requires `SANDBOX_SUPERVISOR_TOKEN` for every provider; leave it empty and `compose up` fails closed.

Optional: set `OPENROUTER_API_KEY` or connect a model in the UI after signup. Claude Pro or Max
and eligible ChatGPT plans connect with their own sign-in in **Settings → Models**
([model subscriptions](./model-subscriptions.md)). Other providers,
local models and approvals are covered in [models](./self-host-models.md).

The example defaults to `latest`, which follows stable releases only. Every publish is multi-arch
(`amd64` + `arm64`), so arm64 hosts need no special tag. A stable release must exist; setup never
falls back to a main build. Automatic updates are disabled by default; opt in to
[scheduled stable updates](./self-host-upgrading.md#scheduled-stable-updates) if desired.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Signup never grants server-administration permissions. Put TLS in front of `:5173` for a public host and set the three public origins to
that HTTPS URL.

Images Compose binds web to loopback (`127.0.0.1:5173`). Terminate TLS on the host and proxy
there. Vite preview same-origin-proxies `/api` and `/rpc`, so do not expose `:3100`. Set
`BETTER_AUTH_URL`, `WEB_ORIGIN`, and `API_URL` to that same HTTPS origin, and set
`RAKAZO_HOST` to its hostname (for example, `app.example.com`). Cookies and CORS follow those
origins.

To also reach the web app by other hostnames (a LAN IP or a tailnet name, for example), list
them comma-separated in `RAKAZO_ALLOWED_HOSTS`. Vite preview rejects any other `Host` header, and
the computer screen then stays blank.

```Caddyfile
app.example.com {
	reverse_proxy 127.0.0.1:5173
}
```

Open **Agent computer** on a bot, or send a message that uses the desktop, to see
the local Docker computer. For in-stack Caddy plus remote E2B computers, use the
[production Compose](./self-host-production.md#public-single-vm-deployment) path and `infra/compose/Caddyfile.prod`
instead of this host proxy.

### From a Docker panel

Server panels that deploy a Compose file from a URL (Hostinger's Docker Manager, Coolify, Dokploy
and similar) need no shell, installer or `.env`. Paste:

```text
https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/docker-compose.standalone.yml
```

It is the images Compose file with one addition: on first start, a one-shot `secrets` service
generates every secret the installer would ([secrets checklist](./self-host-secrets.md)) into the
`secrets` volume. Later starts reuse them and never replace one. Each service gets a copy of only
the secrets it uses. A value you set as an environment variable in the panel always wins over the
generated one, so set it before the first start or not at all: a changed database password or
`ENCRYPTION_KEY` breaks an existing install.

Set `RAKAZO_PUBLIC_URL` to the address people open, such as `https://app.example.com`, whenever
they reach Rakazo by anything but `127.0.0.1`: it sets `BETTER_AUTH_URL`, `WEB_ORIGIN` and `API_URL`
and allows its host, and without it the app refuses that address. Optional variables:

- `OPENROUTER_API_KEY`, or add a model in the app after signup.
- `RAKAZO_WEB_BIND`: the web port stays on `127.0.0.1:5173`, so nothing is public until you choose.
  When the panel's proxy reaches the `web` service on port 5173 over Docker's network, leave it.
  To open the app directly at the server's address, set `RAKAZO_WEB_BIND=0.0.0.0` and
  `RAKAZO_PUBLIC_URL=http://<server-address>:5173`. That serves sign-in over plain HTTP, so use it
  only to try Rakazo and put TLS in front before real use.

The `secrets` volume holds `ENCRYPTION_KEY`, so back it up with the database: encrypted content
cannot be read without it. Removing the stack's volumes deletes both.

[Admin commands](#admin-commands) run through the same start step, which reads the generated
secrets: `docker compose exec api sh /run/rakazo-secrets/start node dist/cli/admin.js …`.

### Restricted networks / mirror downloads

If the installer, Compose downloads, or image pulls are blocked, use the
[restricted-network guide](./self-host-restricted-network.md) for mirror settings and local files.

## Any VPS: paste user data

Hosts such as DigitalOcean, Vultr, Akamai (Linode), Hetzner and Hostinger take a cloud-init
"user data" script when you create a server. Create an Ubuntu 22.04 or newer server of the
[size above](#what-you-need), paste [`infra/cloud-init/user-data.yaml`](../infra/cloud-init/user-data.yaml)
into that field, and Rakazo installs itself into `/opt/rakazo` on first boot with no SSH.
`/var/log/cloud-init-output.log` shows progress.

Its two settings are optional. `OPENROUTER_API_KEY` gives everyone a model; user data stays readable
from the host's metadata service, so you may prefer to connect a model in the app instead. Without
`RAKAZO_DOMAIN`, Rakazo listens only on the server's loopback: open an SSH tunnel with
`ssh -N -L 5173:127.0.0.1:5173 root@SERVER_IP` and browse to `http://127.0.0.1:5173`.

To serve it publicly, point a domain's DNS at the server and run:

```bash
sudo bash /opt/rakazo/setup-server.sh --domain app.example.com
```

This sets the public origins in `.env`, restarts the stack and starts Caddy, which serves the
domain with an automatic HTTPS certificate. Setting `RAKAZO_DOMAIN` in the user data does the same
on first boot. Signup is open, so once your account exists, close it:

```bash
sudo bash /opt/rakazo/setup-server.sh --close-signup
```

The script is safe to rerun, and the login message repeats the next step.

## Docker Compose (single machine)

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` (`openssl rand -hex 16` each), plus `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to independent long random strings (32+ characters; 64 hex for `ENCRYPTION_KEY`). Docker sandboxes also need a dedicated `SANDBOX_SUPERVISOR_TOKEN`. Keep existing `ENCRYPTION_KEY` values so stored credentials stay decryptable.
2. Optional: set `OPENROUTER_API_KEY` for a deployment-wide model connection, or add a model connection in the app after signup. Set `COMPOSIO_API_KEY` only if you want Plugins.
3. Build the computer image: `pnpm sandbox:build` (Compose also builds it via the `computer` service).
4. `docker compose --env-file .env -f infra/compose/docker-compose.yml up --build`
5. Open the web origin (`http://127.0.0.1:5173` by default). Signup never grants server-administration permissions.

On Windows, if an older clone with `core.autocrlf=true` leaves the computer pane hung on boot (`bash\r` in sandbox logs): from a clean worktree, set `git config core.autocrlf false`, run `git add --renormalize . && git checkout -- .`, then rebuild with `pnpm sandbox:build`.

Compose runs Postgres, the sandbox supervisor (Docker socket), API, worker, and a Vite preview of the web app. Bot computers are sibling containers (`rakazo/computer:local`) on separate per-bot networks; only the supervisor and screen proxy join each one. The API process does not get an unrestricted Docker socket; the supervisor owns the lifecycle.

Postgres stays on the Compose network only (not published on the host), matching the images
compose. Credentials come from `.env` (`POSTGRES_PASSWORD` is required). Prefer a URI-safe value
(`openssl rand -hex 16`); characters such as `@ : / ? # %` break the interpolated `DATABASE_URL`
inside Compose. Official Postgres images set user, password, and database only on first volume
init, so an existing database volume keeps its original identity: keep those values in `.env`, or
change them in place with `ALTER ROLE` / rename. Recreate the volume only after a backup (or when
the data is disposable); `docker compose down -v` deletes all Postgres state. For host-side clients
(`pnpm db:migrate`, GUI tools),
add `infra/compose/docker-compose.postgres-host.yml` so Postgres is published on loopback
`127.0.0.1:5433`, or use
`docker compose --env-file .env -f infra/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`.
Do not publish Postgres on a public interface.

## Local (source checkout)

Same as the README quick start: `.env` from `.env.example`, `pnpm sandbox:build`, `pnpm dev`, then the URL it prints ([http://127.0.0.1:5173](http://127.0.0.1:5173) by default, or `http://localhost:5173` — both loopback hosts are trusted). Electron: `pnpm --filter @rakazo/desktop dev` while that stack is up, choosing **Existing instance** with that address. The desktop app's **This computer** option manages a separate local stack, using port 45173 by default so it can run alongside `pnpm dev`. If that port is occupied, the app selects and remembers another loopback port. All desktop traffic uses the web origin. That server is only reachable from the same computer, so phones can't connect to it; see [Desktop "This computer" servers](./self-host-clients.md#desktop-this-computer-servers).

On Apple silicon Macs with macOS 26 or later, builds that include a server bundle can run this stack without Docker. Fresh setups use this path, downloading the server and computer runtime as needed. Existing Docker setups are offered a move while Docker is running; **Keep Docker** preserves the Docker path. Moving copies the bots and data and stops the old Docker stack without removing it. The Docker-free server stops when the desktop app quits.

Other builds and platforms use Docker Compose and the published images (see [Published images](#published-images-no-checkout)); their managed API gets a Docker-assigned loopback port. These Docker containers keep running after the app quits. **Quit and Stop Bots** in the application menu stops the managed stack and quits, for either runtime; switching to another server also stops it. Unpackaged development builds normally have no server bundle; use **Existing instance** for the source development stack.

On headless Linux hosts running the API and worker directly, install Fontconfig and a Latin font for PNG chart labels. On Debian and Ubuntu, install `fontconfig` and `fonts-dejavu-core`.

For source development in WSL, keep the checkout and `data` directory in the Linux filesystem (for example, `~/rakazo`), and run `pnpm dev` as your normal user. The host-run supervisor matches bot container UID/GID to that user. If Docker Desktop container IPs are unreachable, set `SANDBOX_CONTROL_VIA_LOOPBACK=true` in `.env`; this publishes the token-protected control service on a random loopback port. Leave this unset for the Compose-hosted supervisor.

Compose bot homes mount only their own subdirectory of the application volume using Docker volume semantics. Docker's internal volume paths are never used as host bind mounts.

## Configure and operate

- [Configuration](./self-host-configuration.md): how settings reach each service, run limits, the
  database and outbound proxies.
- [Secrets](./self-host-secrets.md): the required keys and how to keep them.
- [Sign-in and accounts](./self-host-accounts.md): who can sign up, [setting up a team](./self-host-accounts.md#set-up-a-team),
  email, SSO, passkeys and passwords.
- [Models](./self-host-models.md): model providers, local models, approvals, media generation and
  voice.
- [Tools and integrations](./self-host-integrations.md): web search, memory, MCP servers,
  messaging apps, cloud coding agents and payments.
- [Bot email addresses](./self-host-inbound-email.md): an address for each bot, so mail you
  forward or CC to it starts its routines.
- [Webhooks on a private network](./self-host-webhooks.md): receive webhooks while the app stays
  on your tailnet, LAN or VPN.
- [Computer providers](./self-host-sandbox-providers.md) and
  [Docker computers](./self-host-docker-computers.md): where bot computers run and how they are
  limited.
- [Kubernetes / k3s installation](./self-host-kubernetes.md): a staged single-node recipe,
  computer isolation and login-gate troubleshooting ([한국어](./ko-KR/self-host-kubernetes.md)).
- [Storage and encryption](./self-host-storage.md): content encryption, object storage and upload
  limits.
- [Production deployment](./self-host-production.md): a public single-VM install with automatic
  HTTPS.
- [Backup and restore](./self-host-backups.md) and [upgrading](./self-host-upgrading.md).
- [Logs and monitoring](./self-host-observability.md): logs, error reports, traces, security events
  and alerts.
- [Audit log](./self-host-audit-log.md): who did what in each organization, retention, export
  and SIEM forwarding.
- [Apps and clients](./self-host-clients.md): mobile and desktop apps, push, client updates and web
  page settings.
- [Billing](./self-host-billing.md): optional Stripe plans and model credits.
- [Restricted networks](./self-host-restricted-network.md): mirrors when downloads are blocked.

## Admin commands

`admin.js` runs operator tasks from the API container. It needs shell access to the server and opens
no port.

```bash
docker compose --env-file .env -f docker-compose.images.yml exec api \
  node dist/cli/admin.js bot webhook-key <bot-id> [--rotate] [--json]
```

`bot webhook-key` gives a bot that has no webhook key a new one and prints its webhook URL
(the [published webhook address](./self-host-webhooks.md) when there is one, else `API_URL`, +
`/api/v1/bots/<bot-id>/webhook`) and the key. When the bot already has one, it
prints only the URL; `--rotate` replaces the key, and the old one stops working. `--json` prints
one line, `{"botId","url","key","created"}`, for piping into another program so the key stays
out of chat and logs. Each new key is recorded as a `credential.changed`
[security event](./self-host-observability.md#security-events) with `by: operator`.

### Account deletion and billing

Grant complimentary own-key access with `node dist/cli/admin.js access grant <email> <free-months> [standard|pro|max|ultra]`.
For example, `node dist/cli/admin.js access grant person@example.test 6 max` gives Max benefits for
six 30-day months without creating a subscription. Grants of the same named tier extend its expiry.
The highest unexpired named tier applies while the organization uses its own API key and has no
active subscription or subscription awaiting billing recovery. Omitting the tier uses the original
Standard access grant.

Run these from the API container. Omit `--confirm` to preview the target and action.

```sh
node dist/cli/admin.js account delete person@example.test --confirm
node dist/cli/admin.js billing cancel person@example.test --confirm
node dist/cli/admin.js billing refund person@example.test EXAMPLE-0001 --confirm
```

- **Account deletion** uses the same cleanup as Settings. It permanently removes the account and
  the Spaces that go with it, cancels their subscriptions, and requires the database job runner.
- **Billing cancellation** immediately ends the selected organization's subscriptions and expires
  its open checkouts. If the account owns several billing organizations, pass the organization ID
  after the email.
- **Billing refunds** return the full amount of a paid invoice with a single, undisputed card
  charge. Review the invoice and credit usage before confirming. Refunds of model-credit
  purchases reconcile through the usual billing sync. Use the separate cancellation command to
  end a recurring plan.

## Reporting a problem

Attach a diagnostics report to a [self-host issue](https://github.com/elie222/rakazo/issues/new?template=self-host.yml):

```bash
docker compose -f docker-compose.images.yml exec api node dist/cli/diagnostics.js
```

From a checkout, use `-f infra/compose/docker-compose.yml` (or the production file) instead. The
report lists the revision, which features are on, migration status, each bot's MCP servers with
their health, and the latest runs. It prints no secrets, settings values, names, addresses,
paths or message content; servers, bots and runs appear only as short hashes.

When a user asks their bot to report a bug or send feedback, the report is saved on your server
in the `feedback_reports` table, with the chat, bot and run it came from. Nothing is sent to the
Rakazo project.
