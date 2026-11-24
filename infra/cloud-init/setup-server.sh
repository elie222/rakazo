#!/usr/bin/env bash
# Installs Rakazo from published images on a fresh Ubuntu server, then optionally serves it on a domain
# with automatic HTTPS. Run as root. Safe to rerun: the cloud-init user-data runs it on first boot, and
# the operator reruns it with --domain or --close-signup.

set -Eeuo pipefail

readonly INSTALL_DIR="${RAKAZO_INSTALL_DIR:-/opt/rakazo}"
readonly SETTINGS_FILE="${RAKAZO_SETTINGS_FILE:-/run/rakazo/settings.env}"
readonly DOWNLOAD_BASE="${RAKAZO_DOWNLOAD_BASE:-https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose}"
readonly HTTPS_PROJECT="rakazo-https"
# The same Caddy build as docker-compose.prod.yml.
readonly CADDY_IMAGE="${CADDY_IMAGE:-caddy:2@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d}"

fail() {
  echo "Rakazo setup failed: $*" >&2
  exit 1
}

usage() {
  echo "Usage: bash setup-server.sh [--domain app.example.com] [--close-signup]" >&2
  exit 2
}

domain=""
close_signup=false
while (($#)); do
  case "$1" in
    --domain)
      [[ $# -ge 2 ]] || usage
      domain="$2"
      shift 2
      ;;
    --close-signup)
      close_signup=true
      shift
      ;;
    *) usage ;;
  esac
done

[[ "$(id -u)" == 0 ]] || fail "run as root, for example with sudo."

# Only the two documented keys are read, without evaluating the file as shell.
read_setting() {
  [[ -r "$SETTINGS_FILE" ]] || return 0
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*[\"']?([^\"'[:space:]]*).*/\1/p" "$SETTINGS_FILE" | tail -n 1
}
[[ -n "$domain" ]] || domain="${RAKAZO_DOMAIN:-$(read_setting RAKAZO_DOMAIN)}"
model_key="${OPENROUTER_API_KEY:-$(read_setting OPENROUTER_API_KEY)}"

domain="$(tr '[:upper:]' '[:lower:]' <<<"$domain")"
domain="${domain#https://}"
domain="${domain%/}"
if [[ -n "$domain" ]] && ! [[ "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; then
  fail "--domain takes a hostname such as app.example.com, not '${domain}'."
fi

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Sets KEY=value in .env, replacing an existing assignment or appending one.
set_env() {
  local key="$1" value="$2" temporary
  temporary="$(mktemp ./.env.tmp.XXXXXX)"
  KEY="$key" VALUE="$value" awk '
    $0 ~ "^[[:space:]]*" ENVIRON["KEY"] "=" { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VALUE"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VALUE"] }
  ' .env >"$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" .env
}

env_value() {
  sed -nE "s/^[[:space:]]*$1=[\"']?([^\"'#[:space:]]*).*/\1/p" .env | tail -n 1
}

curl -fsSL --proto-redir =https --retry 3 -o install-images.sh "${DOWNLOAD_BASE}/install-images.sh" ||
  fail "could not download install-images.sh from ${DOWNLOAD_BASE}."

if [[ ! -e .env ]]; then
  bash install-images.sh --prepare-only
fi
if [[ -n "$model_key" ]]; then
  set_env OPENROUTER_API_KEY "$model_key"
fi
if [[ -n "$domain" ]]; then
  for key in BETTER_AUTH_URL WEB_ORIGIN API_URL; do
    set_env "$key" "https://${domain}"
  done
  set_env RAKAZO_HOST "$domain"
fi
if [[ "$close_signup" == true ]]; then
  set_env SIGNUPS_ENABLED false
fi
# .env holds the settings now; the user-data copy is not needed again.
rm -f -- "$SETTINGS_FILE"

bash install-images.sh

if [[ -n "$domain" ]]; then
  web_bind="$(env_value RAKAZO_WEB_BIND)"
  [[ -n "$web_bind" && "$web_bind" != 0.0.0.0 ]] || web_bind=127.0.0.1
  web_port="$(env_value RAKAZO_WEB_PORT)"
  mkdir -p https
  cat >https/Caddyfile <<'CADDYFILE'
{$RAKAZO_HOST} {
	encode zstd gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy {$RAKAZO_WEB_UPSTREAM}
}
CADDYFILE
  # Host networking reaches the web port wherever .env binds it, loopback by default.
  cat >https/compose.yml <<YAML
name: ${HTTPS_PROJECT}
services:
  caddy:
    image: ${CADDY_IMAGE}
    restart: unless-stopped
    network_mode: host
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    environment:
      RAKAZO_HOST: ${domain}
      RAKAZO_WEB_UPSTREAM: ${web_bind}:${web_port:-5173}
      GODEBUG: multipathtcp=0
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - data:/data
      - config:/config
    tmpfs:
      - /tmp
volumes:
  data:
  config:
YAML
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw allow 443/udp
  fi
  docker compose -f https/compose.yml up -d --force-recreate
fi

public_host="$(env_value RAKAZO_HOST)"
{
  if [[ "$public_host" == localhost ]]; then
    echo "Rakazo answers only on this server. To open it, run this on your computer:"
    echo "  ssh -N -L 5173:127.0.0.1:5173 root@SERVER_IP"
    echo "then open http://127.0.0.1:5173"
    echo
    echo "To serve it on your own domain with HTTPS, point the domain's DNS at this server, then run:"
    echo "  sudo bash ${INSTALL_DIR}/setup-server.sh --domain app.example.com"
  else
    echo "Rakazo is at https://${public_host} once its DNS points at this server."
    if [[ "$(env_value SIGNUPS_ENABLED)" != false ]]; then
      echo "Anyone can sign up. Once your account exists, close signup:"
      echo "  sudo bash ${INSTALL_DIR}/setup-server.sh --close-signup"
    fi
  fi
  echo
  echo "Settings: ${INSTALL_DIR}/.env. Back up ENCRYPTION_KEY from it."
} | tee /etc/motd
