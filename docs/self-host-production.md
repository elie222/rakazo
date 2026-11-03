# Production deployment

Run Rakazo on a public server with automatic HTTPS, hardened hosts and zero-downtime deploys.

## Public single-VM deployment

`infra/compose/docker-compose.prod.yml` runs the hosted product with Postgres, the API, worker, web app,
and automatic HTTPS through Caddy. It uses E2B for bot computers, so the VM never exposes a Docker
supervisor or browser containers — `infra/compose/docker-compose.prod.docker.yml` is the opt-in
overlay that runs local Docker computers on the same stack (see below). The root-equivalent updater
sidecar is an explicit opt-in profile.

Before deploying to a new Ubuntu host, create and verify a key-only `deploy` account, then apply the
idempotent host-hardening baseline. It disables SSH passwords and root login, rate-limits SSH, allows
only SSH/HTTP/HTTPS through UFW, enables fail2ban, unattended security updates, AppArmor, audit rules,
and conservative kernel/network protections. Keep the provider console open until a fresh SSH login
succeeds after the script reloads SSH.

```bash
sudo --preserve-env=SSH_CONNECTION DEPLOY_USER=deploy bash infra/compose/harden-host.sh
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
   `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`,
   `OPENROUTER_API_KEY`, the API key for your selected sandbox provider,
   `RAKAZO_HOST`, and the three public origins. Set `RAKAZO_DEPLOY_DIR` when the checkout is not at
   the supported Linux default, `/srv/rakazo`. Use URL-safe random values for database credentials.
   If you enable the `updater` profile, also set a dedicated `RAKAZO_UPDATER_TOKEN` (at least 32
   characters) that differs from `BETTER_AUTH_SECRET`, `SANDBOX_SUPERVISOR_TOKEN`, and
   `SCREEN_PROXY_SECRET`.
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
# e2b, novita, daytona, or boat
SANDBOX_PROVIDER=e2b
AGENT_RUNTIME=pi
WAKEUP_DRIVER=graphile
DATA_DIR=/data
# Absolute path of this checkout as the Docker daemon sees it. /srv/rakazo is the Linux default;
# set this explicitly for every other layout. See "The deploy directory must be one path" in Upgrading.
RAKAZO_DEPLOY_DIR=/srv/rakazo
RAKAZO_IMAGE_TAG=local
# Optional: required only with `--profile updater`.
# RAKAZO_UPDATER_TOKEN=replace-with-32-plus-character-updater-token
```

4. Build the images from your checkout and start the stack, then verify its public health endpoint:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  build --build-arg GIT_SHA=$(git rev-parse HEAD)
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never
curl --fail https://app.example.com/health
```

**Build, do not pull, for a first deployment.** `RAKAZO_IMAGE_TAG` ships as `local`, a tag no
registry serves, so the commands above build `api`, `worker`, and `web` from the checkout you just
cloned. The opt-in command under [Updater sidecar](./self-host-upgrading.md#updater-sidecar) builds `updater` when needed.

The public `/health` only reports liveness. Runtime, sandbox, and revision details stay on the API
port at `/internal/health`, which the edge does not route:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec api \
  node -e "fetch('http://127.0.0.1:3100/internal/health').then(r=>r.text()).then(console.log)"
```

Passing `GIT_SHA` is what makes `/internal/health` report a `"revision"`; a locally built image has no
other way to know its commit. Prebuilt images from the registry bake it in at publish time, so
switching to a release tag needs nothing more: the containers report the revision the image was built
from, not a `GIT_SHA` in `.env`.

Once a release has been published you can switch this host to prebuilt images by setting
`RAKAZO_IMAGE_TAG` to that release tag and running `pull` followed by `up -d --wait --pull never`.
See [Published images and tags](./self-host-upgrading.md#published-images-and-tags) for the tag contract.

The root `.env` is excluded from both Git and the Docker build context. The database, application data,
and Caddy certificates live in named Docker volumes. The `webassets` volume keeps the hashed web assets
of recent builds (up to 20, each for a week after it is replaced), so open tabs keep loading after an
update; it needs no setup and can be deleted at any time.

The production Compose file pins Postgres and Caddy to multi-architecture manifest digests, and the
published application/updater builds pin their base-image digests. Refresh those pins deliberately
when taking upstream security updates; changing only the visible major tag does not change the
content while a digest is present.

## Client addresses

Sessions, logs, and security events carry the caller's address. The API believes a forwarded
header only when the TCP peer is in `TRUSTED_PROXIES` (IPs, CIDR ranges, or hostnames such as a
Compose service name). It reads that header (`CLIENT_IP_HEADER`, default `x-forwarded-for`) right
to left past trusted hops. Anyone else is the TCP peer, so a client cannot choose its own address.
Unset, `TRUSTED_PROXIES` in a container is `local-networks`: loopback and every network the API
has an interface on. Outside a container it is loopback only, since the host's networks can hold
direct clients. `none` trusts no proxy. In Compose those networks are the stack's own, which hold the web container and the network
gateway a reverse proxy on the Docker host connects from, so a host proxy that sets
`X-Forwarded-For` (Caddy does; nginx needs `proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for`) is believed without configuration. Bot computers are never on those
networks, so they cannot choose an address. Production Compose sets `caddy` instead. For any
other layout, list every proxy between the internet and the API. Sign-in rate limits count per
client address, so a proxy that is not believed makes every user share one limit.

Caddy resolves the client first. `Caddyfile.prod` takes the TCP peer and overwrites
`X-Forwarded-For` with it. Behind a CDN, Caddy has to trust the CDN's ranges and read its client
header: `Caddyfile.cloudflare.example` does this with Cloudflare's ranges and `CF-Connecting-IP`.
For another CDN, copy that file and change the ranges and the header. If you copied the Cloudflare
example before this change, copy it again.

## Firewall changes

Host hardening preserves existing firewall rules and installs `firewall-change.sh` as
`/usr/local/sbin/rakazo-firewall-change`. For subsequent firewall edits, use
`sudo --preserve-env=SSH_CONNECTION /usr/local/sbin/rakazo-firewall-change apply COMMAND...`.
This requires `SSH_CONNECTION` to be preserved, saves both `/etc/ufw` and `/etc/default/ufw`,
and arms a three-minute rollback before running the command.
Open a **new SSH connection** and run the printed `confirm TOKEN` command; confirmation from the
original connection is rejected. An unconfirmed change restores the saved rules and default policies.
The guard does not protect arbitrary direct `ufw` commands or SSH daemon configuration changes.

## Deploying from CI

To deploy from CI, install `infra/compose/deploy-launcher.sh` as `/usr/local/sbin/rakazo-deploy-main`
and give CI a key restricted to it in the deploy user's `authorized_keys`
(`restrict,command="/usr/local/sbin/rakazo-deploy-main" ssh-ed25519 …`). CI deploys a main commit
only after its checks pass and `ci.yml` has published its images, so the host pulls
`<RAKAZO_DEPLOY_IMAGE>:sha-<commit>` instead of building next to live traffic.
`RAKAZO_DEPLOY_IMAGE` defaults to `ghcr.io/<owner>/<repo>/app` for the GitHub repository the
checkout tracks, so a fork pulls what its own CI published. If the pull fails or takes longer than
`RAKAZO_DEPLOY_PULL_TIMEOUT` (default `5m`), the deploy logs a warning and builds the checkout on
the host instead; set `RAKAZO_DEPLOY_IMAGE=` (empty) to always build. This repository's images are public, so the
host needs no registry login; for a private fork package, `docker login ghcr.io` as root with a
token that can only read packages. The deploy
starts each new API, web and worker container beside the running one and stops the old one only
once the new one is healthy, so a deploy does not take the site offline or pause chat, then waits for
`https://$RAKAZO_HOST/health` and rolls back on failure by restoring the image the previous
containers ran. Old and new API containers serve together
for a few seconds after migrations run, so a migration must keep working with the previous
release: add first, and drop or rename only in a later deploy. Pull, build and
start are time-limited so a stuck step fails the deploy instead of holding its lock; a deploy that
finds the lock held exits non-zero. A deploy refuses to start with less than
`RAKAZO_DEPLOY_MIN_FREE_GB` (default `5`) free, and after a healthy rollout it keeps the current and
previous app images (the previous ones tagged `rakazo-rollback`), removes untagged images, and
trims the build cache that fallback builds leave to `RAKAZO_DEPLOY_BUILD_CACHE_GB` (8 GB by default).
For a checkout outside `/srv/rakazo`, put `RAKAZO_DEPLOY_DIR=/absolute/path` (and any of these
settings) in a root-owned `/etc/rakazo/deploy.env` readable by the deploy user. The launcher runs
`infra/compose/deploy-main.sh` from `origin/main`, so deploy changes apply on the next deploy; only
a change to the launcher itself needs
`sudo install -m 0755 infra/compose/deploy-launcher.sh /usr/local/sbin/rakazo-deploy-main`.

## Docker computers on the production stack

Layer `infra/compose/docker-compose.prod.docker.yml` after the base file in every Compose
invocation to run bot computers as local Docker containers instead of a remote provider:

```bash
# Pull only the pull-only dependency images (postgres, caddy, busybox);
# --pull never fails when they are absent locally.
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  pull --ignore-buildable
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  up -d --build --wait --wait-timeout 300 --pull never
```

In this topology `api`, `worker`, `web`, `supervisor`, and `computer` always build
from the checkout — `pull --ignore-buildable` only covers dependencies that have no
`build` section. To deploy published app images instead of building, use the base
file without the overlay. If `docker compose up --help` lacks `--wait-timeout`
(older Compose), drop `--wait` and verify with `docker compose ... ps` instead;
`--wait` alone can hang on one-shot services.

The overlay adds the supervisor (app image, `user: root`, Docker socket), the one-shot `computer`
image build and `data-init` ownership fix, points the API and worker at `http://supervisor:7091`,
and makes `SANDBOX_PROVIDER=docker` the default. It needs a dedicated `SANDBOX_SUPERVISOR_TOKEN`
in `.env`; `RAKAZO_COMPUTER_*` and the `SANDBOX_*` limits apply as documented in `.env.example`.
Like the updater, the supervisor is root-equivalent on the host: it publishes no port, joins only
the internal `app` network, and Caddy has no route to it. Bot computers are sibling containers on
per-bot networks that only the supervisor and the `web` screen proxy join.

When the `updater` profile is enabled too, give the sidecar the same file list and recreate set so
updates do not leave the supervisor on the previous app image:

```env
RAKAZO_COMPOSE_FILE=infra/compose/docker-compose.prod.yml:infra/compose/docker-compose.prod.docker.yml
RAKAZO_UPDATE_SERVICES=supervisor
```

The updater pulls and recreates services but cannot rebuild the `computer` stub image
(`pull_policy: build` is not pullable). Rebuild it on the host when the computer image
should change — for example after updating the checkout:

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.prod.docker.yml \
  build computer
```

## Other deployment layouts

API and worker need always-on processes; serverless request handlers are not sufficient. Use a
Node.js version supported by the root `package.json`, Postgres 16 or newer and a persistent `DATA_DIR` volume shared by API and worker, with encrypted off-host
backups. Homes stay on that volume unless they are kept in
[object storage](./self-host-storage.md#bot-homes-in-object-storage); other `DATA_DIR` files still need it shared.

Use the same HTTPS origin for the web app, `/api`, and `/rpc`. Preserve the authenticated screen
proxy routes. Choose a [computer provider](./self-host-sandbox-providers.md#choosing-a-provider) appropriate to the
service's trust boundary. `SIGNUPS_ENABLED` and `SIGNUP_ALLOWLIST` apply from the environment on every API start.
The optional marketing site in `apps/www` can be hosted separately.
