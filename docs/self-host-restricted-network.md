# Self-hosting on restricted networks

Use a mirror you control or pre-copy files when GitHub or container registries are unreachable.
These settings change downloads; model and remote-computer providers still need network access.

| Failure | Setting or action |
| --- | --- |
| Cannot fetch the installer | Download it from your mirror or copy it locally |
| Cannot fetch Compose files | `RAKAZO_DOWNLOAD_BASE`, `--local`, or `RAKAZO_DOWNLOAD_SKIP_EXISTING=1` |
| Cannot pull app or computer images | `RAKAZO_IMAGE`, `RAKAZO_IMAGE_TAG`, `RAKAZO_COMPUTER_IMAGE`, `RAKAZO_COMPUTER_IMAGE_TAG` |
| Cannot pull Postgres or busybox | `POSTGRES_IMAGE`, `BUSYBOX_IMAGE`, or Docker daemon `registry-mirrors` |

## Installer script

When raw GitHub is unreachable, download the installer from your mirror:

```bash
export RAKAZO_INSTALLER_URL=https://example.com/mirror/rakazo/infra/compose/install-images.sh
mkdir -p rakazo && cd rakazo &&
curl -fsSLO "${RAKAZO_INSTALLER_URL}" &&
bash install-images.sh
```

`RAKAZO_INSTALLER_URL` is used by this curl command; it is not an installer setting.

## Compose files

To mirror `docker-compose.images.yml` and `.env.images.example`, point the installer at an HTTPS
mirror of `infra/compose`:

```bash
export RAKAZO_DOWNLOAD_BASE=https://example.com/mirror/rakazo/infra/compose
bash install-images.sh
```

Trailing slashes are trimmed; non-HTTPS bases are rejected. Downloads use bounded retries.

To reuse files already present in the working directory:

```bash
# Place docker-compose.images.yml and .env.images.example in this directory first.
bash install-images.sh --local --prepare-only
# Equivalent environment setting:
RAKAZO_DOWNLOAD_SKIP_EXISTING=1 bash install-images.sh --prepare-only
```

Missing files are still downloaded. `--prepare-only` creates `.env` without starting the stack;
edit it as needed, then run `bash install-images.sh --local` to start using the local files.

## Container images

After `--prepare-only`, set image overrides in `.env`. For mirrored Postgres or busybox, use
[digest-verified startup](#digest-verified-hub-mirror-startup) below. Otherwise, rerun the installer
(keep `--local` if using pre-copied Compose files):

```env
RAKAZO_IMAGE=registry.example.com/mirror/rakazo/app
RAKAZO_IMAGE_TAG=edge
RAKAZO_COMPUTER_IMAGE=registry.example.com/mirror/rakazo/computer
RAKAZO_COMPUTER_IMAGE_TAG=edge
POSTGRES_IMAGE=registry.example.com/mirror/postgres@sha256:<trusted-postgres-digest>
BUSYBOX_IMAGE=registry.example.com/mirror/busybox@sha256:<trusted-busybox-digest>
```

Mirror both app and computer images and pair their tags to the same published version. Arm64
hosts need multi-architecture tags; see [published images and tags](./self-host.md#published-images-and-tags).
Image overrides are defined in [docker-compose.images.yml](../infra/compose/docker-compose.images.yml).

For Docker Hub images, you can instead merge `registry-mirrors` into the Docker daemon's existing
JSON configuration, then restart Docker:

```json
{
  "registry-mirrors": ["https://mirror.example.com"]
}
```

See the [base daemon configuration](../infra/compose/docker-daemon.json). Docker Hub mirrors do not
replace the GHCR image overrides above.

## Digest-verified Hub mirror startup

Run `bash install-images.sh --prepare-only` in the installation directory first (add `--local`
for pre-copied files). This prepares the Compose file and validates the required secrets without
starting containers.

Treat a mirror as a transport, not as the source of truth. Obtain the expected `postgres:16` and
`busybox:1` digests from a trusted upstream or an out-of-band trusted workstation. Put the digest in
each mirrored image reference, then pull, compare the local repository digests, and start without
pulling again. Replace every example value below before running it:

```bash
(
set -euo pipefail

export POSTGRES_IMAGE='registry.example.com/library/postgres@sha256:<trusted-postgres-digest>'
export BUSYBOX_IMAGE='registry.example.com/library/busybox@sha256:<trusted-busybox-digest>'

docker compose --env-file .env -f docker-compose.images.yml pull

for image_ref in "$POSTGRES_IMAGE" "$BUSYBOX_IMAGE"; do
  expected_digest="${image_ref##*@}"
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_ref" |
    awk -F@ -v expected="$expected_digest" '$2 == expected { found=1 } END { exit !found }' || {
      echo "digest verification failed for $image_ref" >&2
      exit 1
    }
done

docker compose up --help | grep -- '--pull' >/dev/null || {
  echo 'Docker Compose with up --pull is required for verified no-repull startup.' >&2
  exit 1
}
docker compose --env-file .env -f docker-compose.images.yml up -d --pull never
)
```

This sequence fails before startup if pulling or inspection fails, or either image lacks the expected
digest. Save the same `POSTGRES_IMAGE` and `BUSYBOX_IMAGE` references in the installation's `.env`
for later restarts; the exports above apply only to this startup. Do not replace them with mutable
mirror tags. After startup, follow the health checks in [the setup prompt](../SETUP_PROMPT.md).

Once downloads work, continue with [published-image setup](./self-host.md#published-images-no-checkout).
For hosts without external provider access, use local Docker computers and an operator-controlled
model endpoint; see the [self-hosting guide](./self-host.md).
