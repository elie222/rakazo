# Self-host on arm64 (Apple Silicon / aarch64)

Published-images defaults assume **`edge` is `linux/amd64` only**. On arm64
hosts that mismatch shows up as pull errors, exec format errors, or a working
API with a broken computer container.

## Check the host

```bash
uname -m
# arm64 / aarch64 → follow this page
# x86_64 / amd64  → default `edge` tags are fine
```

## Where to run commands

CDN/install downloads land in the current working directory
(`docker-compose.images.yml`, `.env.images.example`, `install-images.sh`).
From that install directory:

```bash
bash install-images.sh
docker compose --env-file .env -f docker-compose.images.yml pull
docker compose --env-file .env -f docker-compose.images.yml up -d
```

From a repo checkout, `cd infra/compose` first (those files live there).

## The pairing rule (both tags together)

`infra/compose/.env.images.example` defaults both tags to `edge` and notes that
`edge` is amd64-only:

```env
RAKAZO_IMAGE=ghcr.io/elie222/rakazo/app
RAKAZO_IMAGE_TAG=edge
RAKAZO_COMPUTER_IMAGE=ghcr.io/elie222/rakazo/computer
RAKAZO_COMPUTER_IMAGE_TAG=edge
```

On arm64:

1. Do **not** leave both on `edge` unless you intentionally run amd64 images
   under emulation (slow, often fragile).
2. Set **`RAKAZO_IMAGE_TAG` and `RAKAZO_COMPUTER_IMAGE_TAG` to the same**
   published **multi-arch** release tag (for example a `vX.Y.Z` or a
   multi-arch `workflow_dispatch` build).
3. Changing **only** `RAKAZO_IMAGE_TAG` leaves the computer service on
   amd64-only `edge`. That partial pin is a common footgun.

Replace `v0.0.0` with a real multi-arch GHCR tag for **both** images, then
pull/up from the install directory (or `infra/compose`):

```env
RAKAZO_IMAGE_TAG=v0.0.0
RAKAZO_COMPUTER_IMAGE_TAG=v0.0.0
```

```bash
bash install-images.sh
# or
docker compose --env-file .env -f docker-compose.images.yml pull
docker compose --env-file .env -f docker-compose.images.yml up -d
```

## Tag availability

| Tag | Typical arch | Notes |
| --- | --- | --- |
| `edge` | amd64 only | Tracks main; default in `.env.images.example` |
| `v*` / release / some manual publishes | amd64 + arm64 | Prefer these on arm64 hosts |
| `latest` | do not assume | May be missing; never invent it |
| `sha-*` | varies | Pin only when you know that digest/tag is multi-arch |

List tags on GHCR (or your mirror) before pinning. If no multi-arch release
exists yet, arm64 hosts cannot use default `edge` without emulation or
building from source (`local` / checkout Compose). See
[docs/self-host.md](./self-host.md#published-images-and-tags).

## Restricted networks + arm64

Registry overrides and tag pairing compose:

```env
RAKAZO_IMAGE=registry.example.com/mirror/elie222/rakazo/app
RAKAZO_COMPUTER_IMAGE=registry.example.com/mirror/elie222/rakazo/computer
RAKAZO_IMAGE_TAG=v0.0.0
RAKAZO_COMPUTER_IMAGE_TAG=v0.0.0
```

Keep app and computer on the **same mirror** and the **same multi-arch tag**.
Hub Postgres/busybox overrides (`POSTGRES_IMAGE` / `BUSYBOX_IMAGE`) are
independent; prefer digest-less tags on mirrors. Registry override details:
[docs/self-host.md](./self-host.md).

Installer warnings when the host is arm64 and tags resolve to `edge` are
complementary. The fix is still to pin both tags.

## Source checkout / prod `local`

Builds with `RAKAZO_IMAGE_TAG=local` produce host-native images from your
checkout (including arm64). That path does not use GHCR `edge`. Switching
later to published tags re-introduces the pairing rule above.

## Verify

From the install directory (or `infra/compose`):

```bash
docker compose --env-file .env -f docker-compose.images.yml images
docker image inspect "$(docker compose --env-file .env -f docker-compose.images.yml images -q api | head -1)" \
  --format '{{.Architecture}}'
curl -fsS http://127.0.0.1:3100/health
```

Architecture should be `arm64` (or your host arch). Health notes:
[docs/self-host.md](./self-host.md).
