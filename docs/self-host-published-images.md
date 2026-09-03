# Self-host with published images (no checkout)

Pull Postgres + `ghcr.io/elie222/rakazo/{app,computer}` into an empty folder.
No git clone and no image build. New file only — does not edit `docs/self-host.md`.

## Prerequisites

- Docker Engine + Compose plugin
- `curl`, OpenSSL
- Outbound reachability to GitHub raw (or your HTTPS mirror) and GHCR/Hub (or overrides)

## Happy path

```bash
mkdir -p rakazo && cd rakazo &&
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh &&
bash install-images.sh
```

The installer downloads `docker-compose.images.yml` and `.env.images.example`,
creates `.env` with random secrets, pulls, and starts. Re-runs preserve `.env`.

UI: http://127.0.0.1:5173 — first registered user becomes deployment owner.
Probe API health on **:3100** (Vite preview does not proxy `/health`):

```bash
curl -fsS http://127.0.0.1:3100/health
```

## Prepare then edit

```bash
bash install-images.sh --prepare-only
# edit .env (origins, tags, optional keys), then:
bash install-images.sh
```

Flags may combine: `--prepare-only`, `--local` (skip curl when Compose files already exist).

## Defaults worth knowing

- Image tag default `edge` is **amd64-only**; arm64 hosts must pin **both** app and computer tags to the same multi-arch release (see `docs/self-host-arm64.md`).
- Do not assume `latest` exists.
- `SANDBOX_PROVIDER` defaults to `docker` (needs `SANDBOX_SUPERVISOR_TOKEN`).
- Secrets must stay distinct — see `docs/self-host-secrets.md`.

## Restricted networks

Override installer URL / download base / registry image env as needed.
Start from `docs/self-host-restricted-network.md` and the satellite guides it lists.
No vendor CDN hostnames as project defaults.

## TLS

Images Compose binds web to `127.0.0.1:5173`. Terminate TLS on the host and
set `BETTER_AUTH_URL`, `WEB_ORIGIN`, `API_URL`, and `RAKAZO_HOST` to that HTTPS origin.
For in-stack Caddy + updater, use the production Compose path instead.

## Stop

```bash
docker compose --env-file .env -f docker-compose.images.yml down
```

Omit `-v` to keep volumes.
