# Self-host pull diagnostics (restricted networks)

Use this page when `bash install-images.sh` or
`docker compose --env-file .env -f docker-compose.images.yml pull` fails on a
network that cannot reach Docker Hub / GHCR reliably. Escape hatches live in
env only; see [Restricted networks / mirror downloads](./self-host.md#restricted-networks--mirror-downloads)
in `docs/self-host.md`. Do not bake vendor-specific CDN hostnames into
compose or scripts.

## Split the failure: installer files vs image pulls

| Stage | What fails | First override |
| --- | --- | --- |
| A / B | Curl of `install-images.sh`, Compose YAML, or `.env.images.example` | `RAKAZO_INSTALLER_URL`, `RAKAZO_DOWNLOAD_BASE` (HTTPS mirror of `infra/compose`) |
| C | `docker compose … pull` of app / computer / Postgres / busybox | `RAKAZO_*_IMAGE*` and/or `POSTGRES_IMAGE` / `BUSYBOX_IMAGE` |

If Stage B succeeds but Stage C fails, leave `RAKAZO_DOWNLOAD_BASE` alone and
fix registry overrides below. Trailing slashes on `RAKAZO_DOWNLOAD_BASE` are
trimmed; non-HTTPS bases are rejected.

## Common Stage C symptoms

### 1. Docker Hub unreachable (Postgres / busybox)

Published-images compose defaults Postgres to a Hub digest pin
(`postgres:16@sha256:…`) and busybox to `busybox:1`. If Hub (or your daemon
mirror of Hub) is blocked, pulls of those two services fail even when GHCR
app/computer tags succeed.

**Fix:** set Hub overrides in `.env` next to the compose file (the
installer copies `infra/compose/.env.images.example`) to a registry you
control that already holds the images:

```env
# Prefer digest when the mirror has it; see section 2 if it only has moving tags.
POSTGRES_IMAGE=registry.example.com/library/postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5
BUSYBOX_IMAGE=registry.example.com/library/busybox:1
```

Unset keeps the compose defaults. Daemon `registry-mirrors` remains a valid
alternative when you prefer not to change `.env`.

### 2. Digest-pinned Hub override misses on a mirror

**Prefer keeping the published digest** when your mirror serves that digest
(content pinning stays intact):

```env
POSTGRES_IMAGE=registry.example.com/library/postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5
```

Copying the Hub default without a registry prefix:

```env
POSTGRES_IMAGE=postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5
```

still talks to Docker Hub (or your daemon Hub mirror). If the mirror **only**
publishes moving tags and rejects digests, fall back to a digest-less tag —
know that **content pinning is lost**:

```env
POSTGRES_IMAGE=registry.example.com/library/postgres:16
```

Before deploying a digest-less override, pull once and record
`docker image inspect … --format '{{index .RepoDigests 0}}'` (or your
registry's digest) so you can verify what actually landed.

### 3. GHCR app / computer pull fails (auth or unreachable)

Defaults are `ghcr.io/elie222/rakazo/{app,computer}` with tags
`RAKAZO_IMAGE_TAG` / `RAKAZO_COMPUTER_IMAGE_TAG` (example default `edge`).
Symptoms: timeout, connection reset, `denied`, `unauthorized`, or HTTP 401/403.

**Fix:** override all four together so app and computer stay on the same
mirror (see `docs/self-host.md`):

```env
RAKAZO_IMAGE=registry.example.com/mirror/elie222/rakazo/app
RAKAZO_IMAGE_TAG=edge
RAKAZO_COMPUTER_IMAGE=registry.example.com/mirror/elie222/rakazo/computer
RAKAZO_COMPUTER_IMAGE_TAG=edge
```

If the mirror is private, `docker login` that registry before `compose pull`.
Arm64 hosts: pin both tags to the same published multi-arch release rather
than amd64-only `edge` ([Published images and tags](./self-host.md#published-images-and-tags)).

### 4. Registry rate limit (HTTP 429)

Anonymous Hub pulls can hit rate limits. Authenticate to the registry you are
actually pulling from (`docker login`), space out retries, or pull from a
registry you control via the env overrides above. Installer curl downloads
(Stage B) already use finite retries; image pulls are separate.

## Quick checklist

1. Confirm whether the failing URL is raw GitHub / your file mirror
   (`RAKAZO_DOWNLOAD_BASE`) or a container registry (Hub / GHCR / your mirror).
2. For Hub Postgres/busybox: set `POSTGRES_IMAGE` / `BUSYBOX_IMAGE` to
   **digest-less** tags on a reachable registry.
3. For GHCR app/computer: set `RAKAZO_IMAGE`, `RAKAZO_IMAGE_TAG`,
   `RAKAZO_COMPUTER_IMAGE`, `RAKAZO_COMPUTER_IMAGE_TAG` together.
4. Re-run `bash install-images.sh` or
   `docker compose --env-file .env -f docker-compose.images.yml pull`.
5. Do not introduce vendor CDN brand defaults into tracked compose or docs
   beyond the generic `registry.example.com` / `example.com` placeholders.

## Related

- [Self-hosting](./self-host.md): Restricted networks, published images, TLS
- `infra/compose/.env.images.example`: installer-generated `.env` template
- `infra/compose/docker-compose.images.yml`: `${POSTGRES_IMAGE:-…}`,
  `${BUSYBOX_IMAGE:-…}`, `${RAKAZO_IMAGE:-…}` / `${RAKAZO_COMPUTER_IMAGE:-…}`
