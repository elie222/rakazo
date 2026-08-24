# Self-hosting Rakazo

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, Daytona, or Box). It is not a static site. The marketing site in `apps/www` can be hosted separately.

## Local (source checkout)

Same as the README quick start: `.env` from `.env.example`, Postgres via Compose, `pnpm sandbox:build`, `pnpm dev`, then [http://127.0.0.1:5173](http://127.0.0.1:5173). Electron: `pnpm --filter @rakazo/desktop dev` while that stack is up.

## Docker Compose (single machine)

1. Copy `.env.example` to `.env` and set `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` to long random strings. Rakazo refuses placeholder or missing secrets outside `development` / `test` (or when `RAKAZO_ALLOW_DEV_SECRETS=1` is set).
2. Set `OPENROUTER_API_KEY` (and `COMPOSIO_API_KEY` if you want Plugins).
3. Build the computer image: `pnpm sandbox:build` (Compose also builds it via the `computer` service).
4. `docker compose --env-file .env -f infra/compose/docker-compose.yml up --build`
5. Open the web origin (`http://127.0.0.1:5173` by default). The first registered user becomes the deployment owner.

On Windows, if an older clone with `core.autocrlf=true` leaves the computer pane hung on boot (`bash\r` in sandbox logs): from a clean worktree, set `git config core.autocrlf false`, run `git add --renormalize . && git checkout -- .`, then rebuild with `pnpm sandbox:build`.

Compose runs Postgres, the sandbox supervisor (Docker socket), API, worker, and a Vite preview of the web app. Bot computers are sibling containers (`rakazo/computer:local`). The API process does not get an unrestricted Docker socket; the supervisor owns the lifecycle.

Postgres is published on **loopback only** (`127.0.0.1:5433` on the host). Do not expose that port on a public VPS. Change `POSTGRES_PASSWORD` and keep Postgres on an internal network when you deploy remotely.

The Docker supervisor is not published. It is authenticated and stays on the internal Compose network because access to it is equivalent to control of the Docker host. It uses `BETTER_AUTH_SECRET` as its shared service credential by default; advanced deployments can set the same independent `SANDBOX_SUPERVISOR_TOKEN` value on the API, worker, and supervisor.

On a VPS, put TLS in front of `:5173` (or serve the web build behind your proxy) and set:

```env
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
```

Cookies and CORS follow those origins. Keep `SIGNUPS_ENABLED` / `SIGNUP_ALLOWLIST` tight on a public host.

Optional:

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SANDBOX_PROVIDER=docker   # or e2b, daytona, box. Keep fake only for pnpm test.
AGENT_RUNTIME=pi          # Keep scripted only for pnpm test.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause the bot computer after 10 minutes idle
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
DAYTONA_API_KEY=          # when SANDBOX_PROVIDER=daytona
BOX_API_KEY=              # when SANDBOX_PROVIDER=box
```

To use an operator-controlled OpenAI-compatible server such as Ollama, LM Studio, llama.cpp, or
MLX, list its model IDs and an endpoint that both the API and worker processes can reach:

```env
RAKAZO_LOCAL_MODELS=qwen3:4b,llama3.1:8b
RAKAZO_LOCAL_MODELS_URL=http://127.0.0.1:11434/v1
RAKAZO_LOCAL_CONTEXT_WINDOW=32768
RAKAZO_LOCAL_MAX_TOKENS=4096
```

The loopback default is suitable when running Rakazo from a source checkout. In Docker Compose,
use the model server's Compose service name or another address reachable from the containers.
Only configure an endpoint you control: prompts, attachments, and tool results sent to that model
leave Rakazo through this URL. Leave `RAKAZO_LOCAL_MODELS` blank to disable the provider.

Do not commit `.env`. Never put `COMPOSIO_API_KEY`, OpenRouter keys, or provider tokens in git, logs, or chat.

## Choosing a computer provider

The Electron desktop app is a client of the same API. Docker and E2B still apply. On first launch, Electron asks the deployment owner whether bots should keep using Docker or run on this Mac as you. `SANDBOX_PROVIDER=desktop` is a separate, explicit provider that always runs commands on the service host.

- **Docker** is the default for local use and the quickest self-hosted setup. Workspace bots share a persistent Team Computer by default; Private computers are optional. Keep the supervisor private, as the included Compose file does.
- **E2B** runs bot computers away from the Rakazo host and is the recommended choice for public or multi-user production deployments. Rakazo checkpoints the portable workspace and browser-profile directory to `DATA_DIR`; the E2B disk is a runtime cache, not the durable source of truth.
- **Daytona** provides the same remote-computer contract through Daytona sandboxes. Configure `DAYTONA_API_KEY` and optionally `DAYTONA_API_URL` / `DAYTONA_TARGET`.
- **Box by ASCII** provides a managed Linux desktop through `BOX_API_KEY` and optionally `BOX_API_URL`. Rakazo always creates or resumes boxes with `noEnv: true`, keeps the portable workspace under `/home/user/rakazo-home`, and refreshes a two-hour TTL. A Box currently exposes one shared desktop, so concurrent Team bots can still use shell and files but only one can use graphical tools at a time.
- **Desktop provider** / **This Mac** runs commands on the API/worker host. Docker stays the default. The Electron app asks once; if you choose This Mac, bots can use working directories under your home folder. Do not enable it on a public or shared service. macOS does not show its own permission dialog for this.
- **Fake** is only an emulator for verification.

## Backup

```bash
./scripts/backup.sh
```

This dumps Postgres (`pg_dump`) and archives `data/` into `backups/<stamp>/`.

## Public single-VM deployment

`infra/compose/docker-compose.prod.yml` runs the hosted product with Postgres, the API, worker, web app,
and automatic HTTPS through Caddy. It uses E2B for bot computers, so the VM never exposes a Docker
supervisor or browser containers.

Before deploying to a new Ubuntu host, create and verify a key-only `deploy` account, then apply the
idempotent host-hardening baseline. It disables SSH passwords and root login, rate-limits SSH, allows
only SSH/HTTP/HTTPS through UFW, enables fail2ban, unattended security updates, AppArmor, audit rules,
and conservative kernel/network protections. Keep the provider console open until a fresh SSH login
succeeds after the script reloads SSH.

```bash
sudo DEPLOY_USER=deploy bash infra/compose/harden-host.sh
```

The production host also uses `infra/compose/docker-daemon.json` to enable live restore, bounded local
container logs, default no-new-privileges, and the kernel NAT path instead of Docker's userland proxy.

1. Point an `A`/`AAAA` record such as `app.example.com` at the VM and allow inbound TCP 80/443 and
   UDP 443. If you use Cloudflare, enable the proxy with **Full (strict)** TLS and copy
   `Caddyfile.cloudflare.example` to an operator-controlled path outside the public checkout. Set
   `CADDYFILE_PATH` to that absolute path. The example drops application requests that do not come
   from Cloudflare's [published IP ranges](https://www.cloudflare.com/ips/); reconcile those ranges
   whenever Cloudflare publishes a change. A Cloudflare Tunnel can replace the public web listeners.
2. Clone the repository on the VM and create a root `.env` with production-only values. At minimum set
   `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `E2B_API_KEY`, `OPENROUTER_API_KEY`,
   `RAKAZO_HOST`, and the three public origins. Use URL-safe random values for database credentials.
3. Keep registration allowlisted while the service is private:

```env
NODE_ENV=production
RAKAZO_HOST=app.example.com
# Optional operator-owned override, for example the Cloudflare allowlist file:
# CADDYFILE_PATH=/etc/rakazo/Caddyfile.prod
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=owner@example.com,reviewer@example.com
SANDBOX_PROVIDER=e2b
AGENT_RUNTIME=pi
WAKEUP_DRIVER=graphile
DATA_DIR=/data
GIT_SHA=
```

4. Start the stack and verify its public health endpoint. Set `GIT_SHA` to the commit you are
   deploying so `GET /health` can prove which revision is live:

```bash
GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d --build
curl --fail https://app.example.com/health
```

The JSON includes `"revision"` matching that commit (or `null` if `GIT_SHA` was omitted).

The root `.env` is excluded from both Git and the Docker build context. The database, application data,
and Caddy certificates live in named Docker volumes.

For the single-VM production layout, install `infra/compose/backup-prod.sh` as
`/usr/local/sbin/rakazo-backup` and enable the supplied `rakazo-backup.timer`. It creates a verified
Postgres custom-format dump plus an application-data archive under `/var/backups/rakazo`, with mode
`0600` and seven-day rotation. These local snapshots help with operator mistakes but are not a
substitute for an encrypted off-host backup or provider snapshot.

## Restore

```bash
./scripts/restore.sh backups/<stamp>
```

## Upgrade

Pull the new source, rebuild with `GIT_SHA=$(git rev-parse HEAD)`, run `pnpm --filter @rakazo/db migrate` if you are not using the production Compose file, then restart API and worker. Product contracts stay compatible across cloud and self-hosted. `GET /health` should then report that commit as `"revision"`.

## What “Rakazo Cloud” still needs

The product cannot be “pushed live” as a Vercel serverless app. Graphile Worker, Postgres `LISTEN`, Pi runs, and Docker computers need durable processes and a sandbox host.

To run a hosted product (same codebase):

1. Push `main` (this checkout may be ahead of GitHub).
2. Provision managed Postgres 16 and run `pnpm db:migrate`.
3. Run **API** and **worker** as always-on Node 22 services (Fly machines, a VM, ECS, k8s). Not lambda-style request handlers.
4. Persist and back up `DATA_DIR` (bot homes, browser profiles, artifacts). Today the concrete store is a local filesystem (`LocalAgentHomeStore`), so attach a Rakazo-owned durable volume shared by API and worker processes. The storage contract is separate from the computer-provider contract, but an object-storage implementation is not wired yet.
5. Choose computers: **`SANDBOX_PROVIDER=e2b`**, `daytona`, or `box` with the matching provider key for a public or multi-user production service. Each Team or Private Computer reconnects to its sandbox id (`providerRef`), while workspace state is checkpointed outside the provider at run completion, explicit stop, and idle suspension. If that sandbox is gone—or the deployment changes providers—the replacement is hydrated from Rakazo's copy. Idle computers pause after `SANDBOX_IDLE_MS` (default 10 minutes) and resume on the next message or Take control. Docker remains the local and trusted single-machine default.
6. A Hetzner CX22 (2 vCPU / 4 GB) is enough for API + worker + Postgres when E2B owns the desktops. 2 GB works for a quiet box; 8 GB is only needed if you also run Docker computers on that same machine.
7. Set public HTTPS `WEB_ORIGIN` / `BETTER_AUTH_URL` / `API_URL`, secrets, and an OpenRouter (or other Pi) deployment key if you want to skip per-user model keys.
8. Put the web app behind the same origin as `/api` and `/rpc` (Vite preview proxy, or a reverse proxy). Docker noVNC connections use short-lived signed `/novnc/*` capabilities; do not replace that route with an unrestricted port proxy.
9. Deploy `apps/www` to your public website and point `app.example.com` (or similar) at the product origin.
10. Turn on `SIGNUP_ALLOWLIST` until you want open registration. There is no Rakazo-managed model billing in version 1 — users bring keys.

Expo / desktop installers are clients of that origin (`EXPO_PUBLIC_API_URL`, `RAKAZO_WEB_URL`). They are not a Cloud control plane.

The iOS and Android app can also point at a self-hosted origin at runtime. On the sign-in screen, tap **Use a custom server** and enter the same HTTPS origin as `WEB_ORIGIN` (for example `https://app.example.com`). Store builds still default to `EXPO_PUBLIC_API_URL`; the in-app setting is an override for people running their own API. Changing the server signs the device out of any previous session.
