# Self-host with published images (no checkout)

Pull Postgres + `ghcr.io/elie222/rakazo/{app,computer}` into an empty folder.
No git clone and no image build.

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

UI: http://127.0.0.1:5173. First registered user becomes deployment owner.
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

- Image tag default `edge` is **amd64-only**; arm64 hosts must pin **both** app and computer tags to the same multi-arch release (see [Published images and tags](self-host.md#published-images-and-tags)).
- Do not assume `latest` exists.
- `SANDBOX_PROVIDER` defaults to `docker` (needs `SANDBOX_SUPERVISOR_TOKEN`).
- Secrets must stay distinct. See [Docker Compose secrets guidance](self-host.md#docker-compose-single-machine).

## Restricted networks

Override installer URL / download base / registry image env as needed.
Start from [Restricted networks / mirror downloads](self-host.md#restricted-networks--mirror-downloads).
No vendor CDN hostnames as project defaults.

## TLS

Images Compose binds web to `127.0.0.1:5173`. Terminate TLS on the host and
set `BETTER_AUTH_URL`, `WEB_ORIGIN`, and `API_URL` to that HTTPS origin, and set
`RAKAZO_HOST` to its hostname (for example, `app.example.com`).
For in-stack Caddy + updater, use the production Compose path instead.

## Stop

```bash
docker compose --env-file .env -f docker-compose.images.yml down
```

Omit `-v` to keep volumes.
