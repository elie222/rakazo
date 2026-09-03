# Self-host restricted-network map

Operator map for Mainland / corporate / flaky-registry installs.
Satellite guides stay in **new files** so they do not edit the hot `docs/self-host.md` surface.
Do not bake vendor CDN hostnames into defaults.

## Install stages (A → C)

| Stage | Failure looks like | First move |
| --- | --- | --- |
| A — fetch installer | curl to raw GitHub fails | `RAKAZO_INSTALLER_URL` or pre-copy script (see README / #516) |
| B — Compose + env example | curl under `infra/compose` fails | `RAKAZO_DOWNLOAD_BASE` or `--local` / `RAKAZO_DOWNLOAD_SKIP_EXISTING=1` |
| C — image pull | GHCR / Hub pull fails | `RAKAZO_*_IMAGE*` and/or `POSTGRES_IMAGE` / `BUSYBOX_IMAGE`; optional daemon registry-mirrors |

Detailed pull failure modes: `docs/self-host-pull-diagnostics.md` (when present).

## Satellite guides

| Topic | Doc |
| --- | --- |
| Pull diagnostics (Hub/GHCR/digest) | `docs/self-host-pull-diagnostics.md` |
| Health probes (`GET /health`, Compose waits) | `docs/self-host-health-checks.md` |
| Outbound HTTP proxy vs TLS vs screen proxy | `docs/self-host-outbound-proxy.md` |
| Offline / air-gap boundaries | `docs/self-host-offline-boundaries.md` |
| Arm64 vs amd64-only `edge` tags | `docs/self-host-arm64.md` |
| Installer secrets and non-reuse | `docs/self-host-secrets.md` |
| `SANDBOX_PROVIDER` modes | `docs/self-host-sandbox-providers.md` |
| Stage A mirror discoverability + daemon mirrors fragment | README + `infra/compose/docker-daemon.registry-mirrors.example.json` |

## Decision tree

1. Cannot download the installer script → Stage A mirror / local copy.
2. Installer runs but cannot fetch Compose YAML → Stage B base or `--local`.
3. Compose pull fails on app/computer → GHCR mirror env (`RAKAZO_IMAGE*`).
4. Pull fails only on Postgres/busybox → Hub overrides or daemon `registry-mirrors`.
5. Stack is up but bots cannot call models / remote sandboxes → day-2 egress (offline + outbound-proxy docs); local `SANDBOX_PROVIDER=docker` still needs a computer image.
6. Arm host + mysterious computer crash → pin both image tags to one multi-arch release (arm64 doc).

Canonical deep narrative remains in `docs/self-host.md` once that file is merge-quiet; until then use this map + satellites.
