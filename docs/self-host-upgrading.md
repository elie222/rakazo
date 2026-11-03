# Upgrading

Move a deployment to a new release, handle one-time migrations, and let the updater sidecar do it
for you.

## Upgrade

A Compose deployment on a published release tag upgrades by moving that tag:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml pull api worker web
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never api worker web
```

A deployment on the default `local` tag has no registry to pull from, so it upgrades by rebuilding
the checkout instead:

```bash
git pull
GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never --build api worker web
```

`up --wait` does not report success until the new API is healthy and the worker and web containers
are running. The API starts only after the `migrate` container finishes, so a migration failure keeps the new API
from starting. A failed CLI recreate does not auto-roll back; recover with the previous
`RAKAZO_IMAGE_TAG` (or rebuild `local`) and `up -d --wait --pull never`.

The updater sidecar has its own image and tag so an update never recreates the process performing
it. Move it deliberately by setting `RAKAZO_UPDATER_IMAGE_TAG` to the full `sha-<commit>` tag, then
running `docker compose … pull updater && docker compose … up -d --wait --pull never updater`.
Sidecar `/apply` and `/rollback` recover a failed recreate by redeploying the previously cached
image when possible; if that also fails, they report a possible mixed-version runtime.

Source checkouts (not Compose) still upgrade the old way: pull, rebuild with
`GIT_SHA=$(git rev-parse HEAD)`, run `pnpm db:migrate`, then restart API and worker.
Product contracts stay compatible across cloud and self-hosted.

## Upgrading to the separate app database login

Releases with [database roles](./self-host-configuration.md#database-roles) need `POSTGRES_APP_PASSWORD` in `.env`. The
desktop app, `install-images.sh`, the updater sidecar and `infra/compose/deploy-main.sh` add it
when it is missing.
Elsewhere, add it yourself (`openssl rand -hex 16`) before you pull, or Compose stops at config
validation with `Set POSTGRES_APP_PASSWORD in .env`. On first start, the API creates the
`rakazo_app` login, and the API and worker then connect as it. Nothing else changes, and the
upgrade does not rewrite any data.

If a feature misbehaves under row-level security, run `ALTER ROLE <login> BYPASSRLS;` on the login
in `DATABASE_URL` (`rakazo_app` in Compose) as a superuser (the Compose owner is one), then
restart the API and worker. Role attributes are not inherited, so granting it to `rakazo_app` does
nothing for a separate login. The app then runs as before, with a startup warning, and later
migrations leave that login alone. Undo it with
`NOBYPASSRLS` and another restart, then search the API and worker logs for
`violates row-level security` and `without a tenant or system context`. An older release ignores
the extra variable and connects as the owner, but releases from the same day also encrypt content
at rest: run `content-encryption decrypt` before rolling back past them
([content encryption](./content-encryption.md#rollout)), or older releases show ciphertext.

## Upgrading to Postgres 18

The production and source-checkout Compose files run Postgres 18. Installs created before that
keep their data in a Postgres 16 volume (`pgdata`), which Postgres 18 cannot open. Until the data
is copied to the new `postgres` volume, the database container exits and logs that it found
PostgreSQL data in `/var/lib/postgresql/16/docker`, and production deploys stop before replacing
anything. Nothing is deleted or started empty. New installs need nothing. The published-images
file (`docker-compose.images.yml`, also used by the desktop app) stays on Postgres 16.

Take a backup and run the drill on it first ([encrypted backups](./self-host-backups.md#encrypted-and-off-site-backups)).
Then update the checkout and run the upgrade as root:

```bash
cd /srv/rakazo
git pull --ff-only
sudo infra/compose/upgrade-postgres.sh
```

When the stack uses other Compose files, such as the Docker computers overlay or the
source-checkout stack, pass all of them:
`sudo RAKAZO_DEPLOY_DIR="$PWD" infra/compose/upgrade-postgres.sh infra/compose/docker-compose.yml`.
Set `COMPOSE_PROJECT_NAME` if the stack runs under a custom `-p`, and on restricted networks set
`RAKAZO_POSTGRES_16_IMAGE` to your mirror of the previous Postgres 16 image (`POSTGRES_IMAGE` must
now name a Postgres 18 image).

The script stops the stack, copies every role (with its password) and database from Postgres 16
with `pg_dumpall`, and compares roles, memberships, ownership, grants, row-level security
policies, sequences and the row count of every table. It also checks that `rakazo_app` signs in
with `POSTGRES_APP_PASSWORD` and does not bypass row-level security. Only then does it switch
Postgres 18 over and restart the services that were running. The site is down for the whole copy,
which takes about as long as dumping and restoring the database: a few minutes for a small one. It needs free disk for one more copy of the
database plus 1 GiB. Running it again after it succeeded does nothing. If any step fails, it stops
with the stack down and the Postgres 16 data unchanged; fix the error and run it again. On the
production host, then rerun the deploy that stopped.

The Postgres 16 volume stays as it was, mounted read-only. To roll back, check out the previous
release and start the stack: it runs Postgres 16 on the original data. Anything written after the
upgrade exists only on Postgres 18, so roll back right away or not at all, and pause CI deploys
until you upgrade again. Once you no longer need the rollback, stop `postgres`, remove the
`<project>_pgdata` volume and start it again; Compose recreates that volume empty.

## Space privacy-boundary migration

Before upgrading across migration `20260830200000_space_scope_names_and_user_credentials`, check
that every existing model and voice credential still belongs to a member of its Space. This query
uses the pre-migration `workspaceId` column name and must return no rows:

```sql
SELECT 'model' AS credential_type, credential."id", credential."userId",
       credential."workspaceId" AS "spaceId"
FROM "user_model_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL
UNION ALL
SELECT 'voice', credential."id", credential."userId", credential."workspaceId"
FROM "user_voice_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL;
```

The migration renames columns used by the API and worker and is therefore a coordinated cutover,
not an online rolling migration. Stop the old API and worker, apply the migration, and start the new
versions together. Its lock waits are bounded so contention fails the migration instead of leaving
application traffic queued indefinitely.

## Published images and tags

`.github/workflows/publish-server-image.yml` publishes to `ghcr.io/<owner>/<repo>/…`, derived from
`${{ github.repository }}` rather than hardcoded, so a fork's CI fills the fork's own namespace. For
this repository that is:

| Image | Contents |
| --- | --- |
| `ghcr.io/elie222/rakazo/app` | api, worker, web, and sandbox supervisor — one image, multiple commands |
| `ghcr.io/elie222/rakazo/computer` | Linux desktop used as each bot computer |
| `ghcr.io/elie222/rakazo/updater` | the updater sidecar, plus the Docker CLI |

`infra/compose/docker-compose.images.yml` is the no-checkout path for those app and computer tags
plus Postgres. The supervisor runs from the app image on the internal network only (not a separate
published supervisor image, and no host port). Production Compose (`docker-compose.prod.yml`) can
also pull the same app tags once `RAKAZO_IMAGE_TAG` is set to a published value.

If you deploy from your own fork, set `RAKAZO_IMAGE` and `RAKAZO_UPDATER_IMAGE` to your namespace —
your CI cannot publish into someone else's.

| Tag | Published on | Moves? |
| --- | --- | --- |
| `local` | nothing — built locally by `up --build` | rebuilt in place |
| `local-<full-commit>` | nothing — built on the server by a fork update | never |
| `vX.Y.Z`, `vX.Y` | release tags | conventionally no / on patch releases |
| `latest` | stable `vX.Y.Z` tags only (not prereleases) | yes, to the newest stable release |
| `sha-<full-commit>` | every main commit, release tag and manual run | source-addressed; used by the updater sidecar |
| `edge` | pushes to main | yes, to the newest main build |

Every publish, including `edge` from main merges, is multi-arch (`amd64` + `arm64`): each
architecture builds natively, on Depot when the `DEPOT_PROJECT_ID` repository variable names a
project and on GitHub's runners otherwise, and one manifest is assembled per image. Depot builds
publish and attest each image in the same job; native GitHub builds combine their architecture
artifacts in a separate publication job. Main CI revisions validate independently. Publication
locks are per image, and a superseded main build keeps its commit tag without moving `edge`.
Image and release queues retain pending jobs so a slower older run cannot displace a newer one.
Production deployment remains serialized and deploys the exact revision that passed its checks.
Before any tag points at a new app image, CI fails the publish if it holds a `.env` file, a `.git` directory or a
private key (`infra/compose/check-image.sh`). Until a
stable `vX.Y.Z` has been published, GHCR may only have `edge` and `sha-*` tags; do not pin
`latest` unless that tag exists in the registry.

Building the images yourself does not need QEMU. `docker compose up --build` builds for the host's
own architecture, and a fork publishing multi-arch images should do what `publish-server-image.yml`
does: build each architecture on a native runner (GitHub Actions provides `ubuntu-24.04-arm` for
public repositories) and merge the digests into one manifest. QEMU emulation
(`docker/setup-qemu-action`, `binfmt`) still works if you have no native arm64 machine, but it is
many times slower, hours rather than minutes for the `computer` image.

The updater resolves the newest stable `vX.Y.Z` source tag but deploys its `sha-<full-commit>` image,
not `latest` or a moving minor tag. A registry tag is not an OCI digest and GHCR package writers can
replace it, so the trust boundary remains this repository's publishing credentials. The workflow
reduces that boundary by using SHA-pinned actions, read-only pull-request jobs, digest-pinned base
images, SBOM/provenance output, and a GitHub build attestation. Operators who require registry-level
content addressing can pin `RAKAZO_IMAGE` outside the automatic updater to a verified digest.

Rollback never contacts the registry: it redeploys the previous tag from the local Docker cache,
so a later tag move cannot change rollback content. Do not prune the previous application image
until the next update has been accepted. If it is missing, rollback fails closed instead of pulling
new content under an old tag.

To populate the registry the first time, run the workflow manually (`workflow_dispatch`) or push a
`v*` tag. A manual run produces `sha-<full-commit>`; only a stable `vX.Y.Z` tag (no prerelease
suffix) produces `latest`, and any `v*` tag produces semver tags. The updater ignores prereleases
and refuses the official path until a stable `vX.Y.Z` exists.

## Updater sidecar

Compose production deployments offer an opt-in `updater` profile on a private `control` network.
Normal deployments do not start it or require its credential. To enable it, set a dedicated
`RAKAZO_UPDATER_TOKEN` and explicitly start the profile:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater up -d --build updater
```

It exposes `/health`, `/state`, `/plan`, `/apply`, and `/rollback` at `http://updater:7092` with
`RAKAZO_UPDATER_TOKEN`. Operator CLI upgrades above do not need it; the sidecar is for automated
apply/rollback over that private HTTP API. Only deployment tooling calls it; app accounts have no update endpoint, and the application API does not receive the updater token.

The API cannot update itself — its image has no `.git`, and nothing inside the container would
restart it — so the work happens in a separate `updater` container that outlives the recreate:

- *Official repository:* resolves the newest stable release and its source commit with
  `git ls-remote --tags`, pins the corresponding full `sha-<commit>` image tag in `.env`, keeps the
  outgoing tag in `RAKAZO_IMAGE_TAG_PREVIOUS`, explicitly pulls the new image, then runs
  `up -d --wait --pull never`. No build runs on the server.
- *Fork (Advanced):* a fork has no published images, so the sidecar fast-forwards the checkout in
  `RAKAZO_DEPLOY_DIR` and runs `up -d --build`. This builds on the server and takes minutes rather
  than seconds. Point it only at a fork you control and have reviewed — the sidecar runs that
  Compose file through a root-equivalent Docker socket.

Updates and rollbacks run one at a time. A failed pull leaves running services alone; a failed recreate restores the previous environment
pin and attempts to redeploy the cached previous image. A failed fork build also restores the
pre-update branch and commit (including when checkout succeeded but merge did not) so a later
manual `--build` cannot deploy the rejected or unintended revision. Database migrations are not
reversed. The sidecar never recreates itself, never touches Postgres or Caddy, and never runs
migrations — that ordering belongs to the API's dependency on the `migrate` service.

Only `https://` and `ssh://` git remotes are accepted. Merges are fast-forward only. A dirty or
untracked source tree fails closed before anything runs (the application Dockerfile uses `COPY . .`).

## The deploy directory must be one path

`RAKAZO_DEPLOY_DIR` is bind-mounted into the updater at the same path it is read from
(`${RAKAZO_DEPLOY_DIR}:${RAKAZO_DEPLOY_DIR}`), and that is load-bearing rather than tidy. Production
Compose defaults both sides to `/srv/rakazo`; set the variable for any other layout. When the
updater runs `docker compose -p <project> --file $RAKAZO_DEPLOY_DIR/infra/compose/docker-compose.prod.yml up -d`,
the Compose CLI *inside* the container expands this file's relative bind mounts — `../../.env`,
`./Caddyfile.prod` — against that path and hands the results to the daemon. The daemon has to be
able to resolve the same strings, or it silently creates empty directories where your `.env` and
Caddyfile should be. Compose makes the effective `-p` value available for interpolation but does
not automatically put it in a container's environment, so the production file explicitly assigns
`COMPOSE_PROJECT_NAME` to the updater. A standalone sidecar can instead set
`RAKAZO_COMPOSE_PROJECT_NAME`; the final fallback is `rakazo-prod`. Without that propagation, a
stack started with `-p something-else` would be left alone while a second project with a new empty
Postgres volume came up beside it.

The value therefore has to be the path **the daemon** sees, which is not always the path your shell
sees:

- **Linux.** The daemon shares the host filesystem, so the checkout path is the answer:
  `/srv/rakazo` is the default and supported production layout. Set `RAKAZO_DEPLOY_DIR` explicitly
  when the checkout is elsewhere.
- **Docker Desktop (Windows/macOS).** The daemon runs in a VM that mounts your drive somewhere else.
  On Windows, `C:` appears at `/run/desktop/mnt/host/c`, so a checkout at `C:\Users\you\rakazo` is
  `RAKAZO_DEPLOY_DIR=/run/desktop/mnt/host/c/Users/you/rakazo`. Host Git may use `core.autocrlf=true`; the updater ignores CR-only diffs so that does not block `/apply`. Verify the mount before deploying:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater run --rm updater git -C "$RAKAZO_DEPLOY_DIR" log --oneline -1
```

  That must print your checkout's HEAD. The two tempting wrong answers both fail: a native Windows
  path is rejected by the daemon (`mount denied: … too many colons`, because the drive letter's
  colon collides with the bind-mount separator), and `/mnt/c/...` fails *silently* — the container
  starts, the mount is an empty directory, and the updater simply reports no checkout.

## Deployments that layer a Compose overlay

`RAKAZO_COMPOSE_FILE` takes a list, separated the way Compose's own `COMPOSE_FILE` is
(`:` by default, or whatever `COMPOSE_PATH_SEPARATOR` says). Each entry becomes its own `--file`,
in the order given, so the updater reconciles the same stack the operator runs by hand:

```
RAKAZO_COMPOSE_FILE=infra/compose/docker-compose.prod.yml:ops/compose/overlay.yml
```

Every entry is validated separately and must stay inside `RAKAZO_DEPLOY_DIR`.

If the overlay adds a service built from the application image, name it in
`RAKAZO_UPDATE_SERVICES` (comma separated) so it is pulled, recreated and rolled back with the
rest. Otherwise an update leaves that service running the previous code:

```
RAKAZO_UPDATE_SERVICES=supervisor
```

These names are appended to the built-in `api`, `worker`, `web`, never substituted for them, so no
value here can drop a core service from an update.

## The updater's privileges

The updater holds the Docker socket, which is root-equivalent on the host. It is scoped as narrowly
as that allows:

- No `ports`, so nothing is published on the host.
- Only on the dedicated `control` network shared with the API. Caddy is not attached, so the
  reverse proxy has no route to the updater.
- Every route except `/health` requires the shared bearer token, compared in constant time.
- The process environment carries only updater settings (`RAKAZO_UPDATER_TOKEN`, deploy path,
  image name, project name). Application secrets stay in the bind-mounted `.env` that Compose
  reads for interpolation; they are not loaded into this container.
- The Docker CLI lives only in the updater image. The api, worker, and web containers keep
  `cap_drop: ALL` and no socket.

Enabling the `updater` profile requires `RAKAZO_UPDATER_TOKEN` to be a dedicated random value (at
least 32 characters in production). It must differ from `BETTER_AUTH_SECRET`,
`SANDBOX_SUPERVISOR_TOKEN`, and `SCREEN_PROXY_SECRET`. Leave the profile disabled if you would
rather not grant the capability.
