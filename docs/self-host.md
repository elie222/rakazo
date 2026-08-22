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

Compose runs Postgres, the sandbox supervisor (Docker socket), API, worker, and a Vite preview of the web app. Bot computers are sibling containers (`rakazo/computer:local`). The API process does not get an unrestricted Docker socket; the supervisor owns the lifecycle.

Postgres is published on **loopback only** (`127.0.0.1:5433` on the host). Do not expose that port on a public VPS. Change `POSTGRES_PASSWORD` and keep Postgres on an internal network when you deploy remotely.

The Docker supervisor is not published. It is authenticated and stays on the internal Compose network because access to it is equivalent to control of the Docker host. It uses `BETTER_AUTH_SECRET` as its shared service credential by default; advanced deployments can set the same independent `SANDBOX_SUPERVISOR_TOKEN` value on the API, worker, and supervisor.

The development Compose file has no `updater` service, so in-app updates here use the git-checkout engine against your working tree. The updater sidecar is a production concern; see [Upgrade](#upgrade).

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

The Electron desktop app is a client of the same API and never decides where bots run. The provider is fixed by the operator at deploy time through `SANDBOX_PROVIDER`; a connected client cannot change it. Docker and E2B still apply.

- **Docker** is the default for local use and the quickest self-hosted setup. Workspace bots share a persistent Team Computer by default; Private computers are optional. Keep the supervisor private, as the included Compose file does.
- **E2B** runs bot computers away from the Rakazo host and is the recommended choice for public or multi-user production deployments. Rakazo checkpoints the portable workspace and browser-profile directory to `DATA_DIR`; the E2B disk is a runtime cache, not the durable source of truth.
- **Daytona** provides the same remote-computer contract through Daytona sandboxes. Configure `DAYTONA_API_KEY` and optionally `DAYTONA_API_URL` / `DAYTONA_TARGET`.
- **Box by ASCII** provides a managed Linux desktop through `BOX_API_KEY` and optionally `BOX_API_URL`. Rakazo always creates or resumes boxes with `noEnv: true`, keeps the portable workspace under `/home/user/rakazo-home`, and refreshes a two-hour TTL. A Box currently exposes one shared desktop, so concurrent Team bots can still use shell and files but only one can use graphical tools at a time.
- **Desktop provider** runs commands directly on the API/worker host under the service account, with working directories allowed anywhere under that account's home folder. There is no container boundary, so it is opt-in only through `SANDBOX_PROVIDER=desktop` and cannot be turned on from the app. Do not use it on a public or shared service.
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
# Absolute path of this checkout as the Docker daemon sees it. Required: the updater sidecar is
# bind-mounted at exactly this path so Compose resolves the same bind mounts inside the container
# that it does from your shell. See "The deploy directory must be one path" below.
RAKAZO_DEPLOY_DIR=/srv/rakazo
RAKAZO_IMAGE_TAG=local
```

4. Build the images from your checkout and start the stack, then verify its public health endpoint:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  build --build-arg GIT_SHA=$(git rev-parse HEAD)
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d
curl --fail https://app.example.com/health
```

**Build, do not pull, for a first deployment.** `RAKAZO_IMAGE_TAG` ships as `local`, a tag no
registry serves, so the commands above build `api`, `worker`, `web`, and `updater` from the checkout
you just cloned. Running `docker compose … pull` first — as earlier versions of this page told you
to — fails outright with `error from registry: denied` whenever the tag you are on has not been
published, and there is nothing to fall back to.

Passing `GIT_SHA` is what makes `GET /health` report a `"revision"`; a locally built image has no
other way to know its commit. Prebuilt images from the registry bake it in at publish time, so when
you switch to a release tag you should leave `GIT_SHA` unset — a value in `.env` would override what
the image already knows.

Once a release has been published you can switch this host to prebuilt images by setting
`RAKAZO_IMAGE_TAG` to that release tag and running `pull` followed by `up -d`. See
[Published images and tags](#published-images-and-tags) for what exists today.

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

A Compose deployment on a published release tag upgrades by moving that tag:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml pull api worker web
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d api worker web
```

A deployment on the default `local` tag has no registry to pull from, so it upgrades by rebuilding
the checkout instead:

```bash
git pull
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --build api worker web
```

`up -d` replaces the API, worker, and web containers together, so the three never disagree about
which version they are. The API's start command runs `prisma migrate deploy` before it serves, which
means migrations happen inside the new container, after the old one has stopped — the old process is
never left talking to a new schema.

The updater sidecar has its own image and tag so that an update never recreates the container
performing it. Move it deliberately:
`docker compose … pull updater && docker compose … up -d updater`.

Source checkouts (not Compose) still upgrade the old way: pull, rebuild with
`GIT_SHA=$(git rev-parse HEAD)`, run `pnpm --filter @rakazo/db migrate`, then restart API and worker.
Product contracts stay compatible across cloud and self-hosted.

### Published images and tags

> **The registry is empty today.** `.github/workflows/publish-server-image.yml` has never run, so
> nothing exists under either image name yet and every `pull` of them fails with
> `error from registry: denied`. Until that workflow runs on a release tag, the only working path is
> building from source, which is why `RAKAZO_IMAGE_TAG` ships as `local`. Everything in this section
> describes what the workflow will publish once it runs, not what you can pull right now.

`.github/workflows/publish-server-image.yml` publishes to `ghcr.io/<owner>/<repo>/…`, derived from
`${{ github.repository }}` rather than hardcoded, so a fork's CI fills the fork's own namespace. For
this repository that is:

| Image | Contents |
| --- | --- |
| `ghcr.io/millson1/rakazo/app` | api, worker, and web — one image, three commands |
| `ghcr.io/millson1/rakazo/updater` | the updater sidecar, plus the Docker CLI |

If you deploy from your own fork, set `RAKAZO_IMAGE` and `RAKAZO_UPDATER_IMAGE` to your namespace —
your CI cannot publish into someone else's.

| Tag | Published on | Moves? |
| --- | --- | --- |
| `local` | nothing — built locally by `up --build` | rebuilt in place |
| `local-<commit>` | nothing — built on the server by a fork update | never |
| `vX.Y.Z`, `vX.Y` | release tags | no / on patch releases |
| `latest` | release tags | yes, to the newest release |
| `sha-<commit>` | every push and manual run | never |
| `edge` | pushes to main | yes, to the newest main build |

Pin `RAKAZO_IMAGE_TAG` to a release tag in production once releases exist. Published tags are
retained, so the tag a deployment ran yesterday is still pullable today — which is what makes
rollback a redeploy rather than a rebuild. The two `local*` tags are the exception: they only exist
on the host that built them, so the updater skips `docker compose pull` when rolling back onto one.
`sha-<commit>` is the immutable identity: the commit in a tag is the commit `GET /health` reports as
`"revision"`, because the workflow bakes it into the image.

To populate the registry the first time, run the workflow manually (`workflow_dispatch`) or push a
`v*` tag. A manual run always produces at least `sha-<commit>`; only a `v*` tag produces `latest`.

### In-app self-update

The deployment owner gets **Server updates** in the account menu. Nobody else can see or call it;
the RPCs are gated on the same `ownerUserId` check as the rest of the deployment settings. There are
two engines, and the overlay tells you which one is in play.

**Compose deployments use the updater sidecar.** The API cannot update itself — its image has no
`.git`, and nothing inside the container would restart it — so the work happens in a separate
`updater` container that outlives the recreate. The API asks it over the Compose network at
`http://updater:7092` with a shared bearer token, and the sidecar does the rest:

- *Official repository:* resolves the newest release tag with `git ls-remote --tags`, pins
  `RAKAZO_IMAGE_TAG` in your `.env`, keeps the outgoing tag in `RAKAZO_IMAGE_TAG_PREVIOUS`, then
  `docker compose pull` and `up -d`. No build on your machine — a download and a restart.

  Two things have to line up for this path to work, and today they do not. It reads release tags
  from `OFFICIAL_REPO_URL` (`packages/core/src/self-update.ts`, currently the upstream
  `elie222/rakazo`) and then pulls that tag from `PUBLISHED_IMAGE_REPO`
  (`packages/core/src/compose-update.ts`, this repository). Release tags and published images only
  agree when both name the same repository, so these two constants should be set from one value.
  Changing `OFFICIAL_REPO_URL` also means updating the default-source expectation in
  `packages/testkit/src/journeys.test.ts`. Until then, drive the pull path by setting
  `RAKAZO_IMAGE`/`RAKAZO_IMAGE_TAG` yourself, or use the fork path below.
- *Fork (Advanced):* a fork has no published images, so the sidecar fast-forwards the checkout in
  `RAKAZO_DEPLOY_DIR` and runs `up -d --build`. This builds on the server and takes **minutes rather
  than seconds**. It needs `RAKAZO_DEPLOY_DIR` to be a git checkout of your fork; the UI says so
  plainly, and refuses rather than guessing.

If any step fails, the sidecar puts the tag back before returning, so a failed update never leaves
the deployment pinned to an image the host does not have. **Roll back** redeploys
`RAKAZO_IMAGE_TAG_PREVIOUS`. It does not reverse migrations: if the newer version added one, roll
forward again or restore from a backup.

What the sidecar deliberately does not do: it never recreates itself, never touches Postgres or
Caddy, and never runs migrations itself — that ordering belongs to the API's own start command,
where it is correct by construction.

**Source checkouts use the in-process engine and need a supervisor.** It runs `git fetch`,
`git checkout`, `git merge --ff-only`, `pnpm install`, `prisma generate`, the web build, and
`prisma migrate`, then exits so that something outside the process starts it again on the new code.
It refuses to exit when it cannot tell that anything will, because a server that exits into nothing
is worse than a server that is out of date. systemd (`INVOCATION_ID`) and pm2 (`pm_id`) are detected
automatically; anything else has to be declared:

```env
RAKAZO_UPDATE_RESTART_SUPERVISOR=docker   # source checkouts only; Compose does not need this
RAKAZO_SELF_UPDATE=0                      # turn the feature off entirely, either engine
```

`RAKAZO_UPDATE_RESTART_SUPERVISOR` is not needed on a Compose deployment: the sidecar performs the
restart, so there is nothing for a supervisor to be asked about. The overlay stops mentioning
supervisors entirely once the sidecar is answering.

Both engines share the same guards. Only `https://` and `ssh://` git remotes are accepted; URLs
carrying credentials, query strings, traversal, leading dashes, or control bytes are refused; every
value reaches git as its own argument with no shell involved; merges are fast-forward only, so a
checkout carrying local commits fails the update instead of losing them; and a checkout with
uncommitted changes to tracked files is refused before anything runs. The sidecar re-runs all of
these itself rather than trusting that the API already did, because it is a separate trust boundary.

Understand what **Advanced** is: the server will run whatever code that repository contains. Point
it at a fork you control, never one you found.

### The deploy directory must be one path

`RAKAZO_DEPLOY_DIR` is bind-mounted into the updater at the same path it is read from
(`${RAKAZO_DEPLOY_DIR}:${RAKAZO_DEPLOY_DIR}`), and that is load-bearing rather than tidy. When the
updater runs `docker compose -p <project> --file $RAKAZO_DEPLOY_DIR/infra/compose/docker-compose.prod.yml up -d`,
the Compose CLI *inside* the container expands this file's relative bind mounts — `../../.env`,
`./Caddyfile.prod` — against that path and hands the results to the daemon. The daemon has to be
able to resolve the same strings, or it silently creates empty directories where your `.env` and
Caddyfile should be. The `-p` value is `COMPOSE_PROJECT_NAME` (Compose injects this into running
services) or `RAKAZO_COMPOSE_PROJECT_NAME`, falling back to `rakazo-prod` from the compose file —
without it, a stack started as `docker compose -p something-else` would be left alone and a second
project with a new empty Postgres volume would come up beside it.

The value therefore has to be the path **the daemon** sees, which is not always the path your shell
sees:

- **Linux.** The daemon shares the host filesystem, so the checkout path is the answer:
  `RAKAZO_DEPLOY_DIR=/srv/rakazo`. This is the supported production layout.
- **Docker Desktop (Windows/macOS).** The daemon runs in a VM that mounts your drive somewhere else.
  On Windows, `C:` appears at `/run/desktop/mnt/host/c`, so a checkout at `C:\Users\you\rakazo` is
  `RAKAZO_DEPLOY_DIR=/run/desktop/mnt/host/c/Users/you/rakazo`. Host Git may use `core.autocrlf=true`; the updater ignores CR-only diffs so that does not block `/apply`. Verify the mount before deploying:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  run --rm updater git -C "$RAKAZO_DEPLOY_DIR" log --oneline -1
```

  That must print your checkout's HEAD. The two tempting wrong answers both fail: a native Windows
  path is rejected by the daemon (`mount denied: … too many colons`, because the drive letter's
  colon collides with the bind-mount separator), and `/mnt/c/...` fails *silently* — the container
  starts, the mount is an empty directory, and the updater simply reports no checkout.

### The updater's privileges

The updater holds the Docker socket, which is root-equivalent on the host. It is scoped as narrowly
as that allows:

- No `ports`, so nothing is published on the host.
- Only on the `app` network. Caddy is on `edge`, so there is no route to the updater from the
  internet and it cannot be reached through the reverse proxy.
- Every route except `/health` requires the shared bearer token, compared in constant time.
- The Docker CLI lives only in the updater image. The api, worker, and web containers keep
  `cap_drop: ALL` and no socket.

Set `RAKAZO_UPDATER_TOKEN` to a random value if you want update authority separate from
`BETTER_AUTH_SECRET`, which it otherwise derives from. Set `RAKAZO_SELF_UPDATE=0` and drop the
`updater` service if you would rather not have the capability at all.

### Desktop auto-update

The Electron app is installed separately from the server, so it can drift. It checks the repository's
GitHub releases shortly after launch and on demand, downloads on request, and installs on restart. A
fork with no published releases, or a machine that is offline, is treated as "no updates available"
rather than an error.

Publishing releases requires the `release-desktop` workflow (tag `v*`) and, for macOS and Windows
clients to accept an update at all, code-signing credentials in `DESKTOP_CSC_LINK`,
`DESKTOP_CSC_KEY_PASSWORD`, and the Apple notarization secrets. A fork also has to change
`build.publish.owner` / `build.publish.repo` in `apps/desktop/package.json` and rebuild, because that
is what is baked into the installed app's update feed. Set `RAKAZO_DISABLE_AUTO_UPDATE=1` to turn it off.

### Version matching

`GET /health` and the `health` RPC report the server's `version` and `revision`. The web build stamps
its own version and commit at build time and compares. A mismatch is a **warning, never a block** —
the app stays fully usable. A browser tab is offered a reload, because its assets come from the
server. The desktop app is told which side is behind, because it serves its own bundled copy of the
web UI and a reload cannot fix it.

## What “Rakazo Cloud” still needs

`apps/www` (Astro, `output: "static"`, `site: https://rakazo.com`) can go live today on Vercel, Cloudflare Pages, or any static host. The waitlist link is `mailto:hello@rakazo.com`. That is the marketing site, not the product.

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
