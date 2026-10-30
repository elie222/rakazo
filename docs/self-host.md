# Self-hosting Rakazo

Run the API, worker, web app, database and bot computers on a machine you control.

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, Daytona, CreateOS, or Boat). It is not a static site. The marketing site in `apps/www` can be hosted separately.

## What you need

- Docker Engine 26 or newer with the Compose plugin, curl and OpenSSL. Nothing else is needed for
  the published images.
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

`SANDBOX_PROVIDER` defaults to `docker`. The images Compose file runs a sandbox supervisor
(from the app image, on the internal network only) and pulls `ghcr.io/elie222/rakazo/computer`.
Signup and local Docker computers work without an E2B account. Optional remote providers: set
`SANDBOX_PROVIDER` to `e2b`, `novita`, `daytona`, `createos`, or `boat` and add the matching API key. The published-images
Compose stack requires `SANDBOX_SUPERVISOR_TOKEN` for every provider; leave it empty and `compose up` fails closed.

Optional: set `OPENROUTER_API_KEY` or connect a model in the UI after signup. Other providers,
local models and approvals are covered in [models](./self-host-models.md).

The example defaults to `edge` (main builds). Every publish is multi-arch (`amd64` + `arm64`), so
arm64 hosts need no special tag. Do not assume `latest` is present until a stable release exists.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Signup never grants server-administration permissions. Put TLS in front of `:5173` for a public host and set the three public origins to
that HTTPS URL.

Images Compose binds web to loopback (`127.0.0.1:5173`). Terminate TLS on the host and proxy
there. Vite preview same-origin-proxies `/api` and `/rpc`, so do not expose `:3100`. Set
`BETTER_AUTH_URL`, `WEB_ORIGIN`, and `API_URL` to that same HTTPS origin, and set
`RAKAZO_HOST` to its hostname (for example, `app.example.com`). Cookies and CORS follow those
origins.

```Caddyfile
app.example.com {
	reverse_proxy 127.0.0.1:5173
}
```

Open **Agent computer** on a bot, or send a message that uses the desktop, to see
the local Docker computer. For in-stack Caddy plus remote E2B computers, use the
[production Compose](./self-host-production.md#public-single-vm-deployment) path and `infra/compose/Caddyfile.prod`
instead of this host proxy.

### Restricted networks / mirror downloads

If the installer, Compose downloads, or image pulls are blocked, use the
[restricted-network guide](./self-host-restricted-network.md) for mirror settings and local files.

## Docker Compose (single machine)

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` (`openssl rand -hex 16` each), plus `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to independent long random strings (32+ characters; 64 hex for `ENCRYPTION_KEY`). Docker sandboxes also need a dedicated `SANDBOX_SUPERVISOR_TOKEN`. Keep existing `ENCRYPTION_KEY` values so stored credentials stay decryptable.
2. Set `OPENROUTER_API_KEY` (and `COMPOSIO_API_KEY` if you want Plugins).
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

Same as the README quick start: `.env` from `.env.example`, `pnpm sandbox:build`, `pnpm dev`, then the URL it prints ([http://127.0.0.1:5173](http://127.0.0.1:5173) by default, or `http://localhost:5173` — both loopback hosts are trusted). Electron: `pnpm --filter @rakazo/desktop dev` while that stack is up, choosing **Existing instance** with that address. The desktop app's **This computer** option instead installs and runs the published images itself with Docker Compose (see [Published images](#published-images-no-checkout)), using port 45173 by default so it can run alongside `pnpm dev`. If that port is occupied, the app selects and remembers another loopback port. The managed API gets a Docker-assigned loopback port; all desktop traffic uses the web origin.

For source development in WSL, keep the checkout and `data` directory in the Linux filesystem (for example, `~/rakazo`), and run `pnpm dev` as your normal user. The host-run supervisor matches bot container UID/GID to that user. If Docker Desktop container IPs are unreachable, set `SANDBOX_CONTROL_VIA_LOOPBACK=true` in `.env`; this publishes the token-protected control service on a random loopback port. Leave this unset for the Compose-hosted supervisor.

Compose bot homes mount only their own subdirectory of the application volume using Docker volume semantics. Docker's internal volume paths are never used as host bind mounts.

## Configure and operate

- [Configuration](./self-host-configuration.md): how settings reach each service, run limits, the
  database and outbound proxies.
- [Secrets](./self-host-secrets.md): the required keys and how to keep them.
- [Sign-in and accounts](./self-host-accounts.md): who can sign up, email, SSO, passkeys and
  passwords.
- [Models](./self-host-models.md): model providers, local models, approvals, media generation and
  voice.
- [Tools and integrations](./self-host-integrations.md): web search, memory, MCP servers,
  messaging apps, cloud coding agents and payments.
- [Computer providers](./self-host-sandbox-providers.md) and
  [Docker computers](./self-host-docker-computers.md): where bot computers run and how they are
  limited.
- [Storage and encryption](./self-host-storage.md): content encryption, object storage and upload
  limits.
- [Production deployment](./self-host-production.md): a public single-VM install with automatic
  HTTPS.
- [Backup and restore](./self-host-backups.md) and [upgrading](./self-host-upgrading.md).
- [Logs and monitoring](./self-host-observability.md): logs, error reports, traces, security events
  and alerts.
- [Apps and clients](./self-host-clients.md): mobile and desktop apps, push, client updates and web
  page settings.
- [Billing](./self-host-billing.md): optional Stripe plans and model credits.
- [Restricted networks](./self-host-restricted-network.md): mirrors when downloads are blocked.
