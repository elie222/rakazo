# Self-host restricted-network map

Operator map for Mainland / corporate / flaky-registry installs.
Do not bake vendor CDN hostnames into defaults.

Canonical detail lives in [self-host.md](./self-host.md), especially
[Restricted networks / mirror downloads](./self-host.md#restricted-networks--mirror-downloads).
Stage A bootstrap discoverability is also summarized in the [README](../README.md).

## Install stages (A → C)

| Stage | Failure looks like | First move |
| --- | --- | --- |
| A: fetch installer | curl to raw GitHub fails | [`RAKAZO_INSTALLER_URL`](./self-host.md#restricted-networks--mirror-downloads) or pre-copy the script ([README](../README.md)) |
| B: Compose + env example | curl under `infra/compose` fails | [`RAKAZO_DOWNLOAD_BASE`](./self-host.md#restricted-networks--mirror-downloads), [`--local`](./self-host.md#restricted-networks--mirror-downloads), or [`RAKAZO_DOWNLOAD_SKIP_EXISTING=1`](./self-host.md#restricted-networks--mirror-downloads) |
| C: image pull | GHCR / Hub pull fails | [`RAKAZO_*_IMAGE*`](./self-host.md#restricted-networks--mirror-downloads), [`POSTGRES_IMAGE`](../infra/compose/docker-compose.images.yml) / [`BUSYBOX_IMAGE`](../infra/compose/docker-compose.images.yml); optional daemon `registry-mirrors` ([how](./self-host.md#restricted-networks--mirror-downloads); base example [docker-daemon.json](../infra/compose/docker-daemon.json)) |

## Decision tree

1. Cannot download the installer script → Stage A mirror / local copy.
2. Installer runs but cannot fetch Compose YAML → Stage B base or `--local`.
3. Compose pull fails on app/computer → GHCR mirror env (`RAKAZO_IMAGE`, `RAKAZO_IMAGE_TAG`, `RAKAZO_COMPUTER_IMAGE`, `RAKAZO_COMPUTER_IMAGE_TAG`).
4. Pull fails only on Postgres/busybox → Hub overrides (`POSTGRES_IMAGE` / `BUSYBOX_IMAGE`) or daemon `registry-mirrors`.
5. Stack is up but bots cannot call models / remote sandboxes → day-2 egress and [computer provider](./self-host.md#choosing-a-computer-provider) choice; local `SANDBOX_PROVIDER=docker` still needs a computer image.
6. Arm host + mysterious computer crash → pin both image tags to one multi-arch release ([Published images and tags](./self-host.md#published-images-and-tags)).

For Hub pulls, prefer `POSTGRES_IMAGE` / `BUSYBOX_IMAGE` when you can vendor those images. If you need a daemon mirror instead, merge a `registry-mirrors` array into your Docker daemon JSON (start from [docker-daemon.json](../infra/compose/docker-daemon.json); do not commit vendor CDN hostnames as repo defaults), then restart Docker so the change takes effect:

```json
{
  "registry-mirrors": ["https://mirror.example.com"]
}
```

## Related guides

Focused `docs/self-host-*.md` satellites may land later. Until then, use these existing pages:

| Topic | Doc |
| --- | --- |
| Restricted networks / Stages A-C | [Restricted networks / mirror downloads](./self-host.md#restricted-networks--mirror-downloads) |
| Published images (no checkout) | [Published images (no checkout)](./self-host.md#published-images-no-checkout) |
| Tags, arm64 pairing, digests | [Published images and tags](./self-host.md#published-images-and-tags) |
| Sandbox / computer providers | [Choosing a computer provider](./self-host.md#choosing-a-computer-provider) |
| Stage A installer discoverability | [README](../README.md) |
| Compose image overrides (`POSTGRES_IMAGE`, `BUSYBOX_IMAGE`, app/computer) | [docker-compose.images.yml](../infra/compose/docker-compose.images.yml) |
| Example Docker daemon config (add `registry-mirrors` locally if Hub is blocked) | [docker-daemon.json](../infra/compose/docker-daemon.json) |
| Full self-host narrative | [self-host.md](./self-host.md) |
