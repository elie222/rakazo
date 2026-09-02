#!/usr/bin/env bash

set -Eeuo pipefail

DOWNLOAD_BASE="${RAKAZO_DOWNLOAD_BASE:-https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose}"
while [[ "$DOWNLOAD_BASE" == */ ]]; do
  DOWNLOAD_BASE="${DOWNLOAD_BASE%/}"
done
case "$DOWNLOAD_BASE" in
  https://*) ;;
  *)
    echo "Rakazo setup failed: RAKAZO_DOWNLOAD_BASE must use https." >&2
    exit 1
    ;;
esac
readonly DOWNLOAD_BASE

readonly COMPOSE_FILE="docker-compose.images.yml"
readonly ENV_EXAMPLE=".env.images.example"
readonly ENV_FILE=".env"

prepare_only=false
skip_existing=false
if [[ "${RAKAZO_DOWNLOAD_SKIP_EXISTING:-}" == "1" ]]; then
  skip_existing=true
fi

for arg in "$@"; do
  case "$arg" in
    --prepare-only)
      prepare_only=true
      ;;
    --local)
      skip_existing=true
      ;;
    *)
      echo "Usage: bash install-images.sh [--prepare-only] [--local]" >&2
      exit 2
      ;;
  esac
done

temporary_file=""
cleanup() {
  if [[ -n "$temporary_file" ]]; then
    rm -f -- "$temporary_file"
  fi
}
trap cleanup EXIT

fail() {
  echo "Rakazo setup failed: $*" >&2
  exit 1
}

for command_name in curl docker openssl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "'$command_name' is required."
done

docker compose version >/dev/null 2>&1 || fail "the Docker Compose plugin is required."

curl_download() {
  local url="$1"
  local out="$2"
  local attempt
  local max_attempts=3

  if curl --help all 2>/dev/null | grep -q -- '--retry-all-errors'; then
    curl -fsSL --proto-redir =https --retry 3 --retry-delay 2 --retry-all-errors "$url" -o "$out"
    return $?
  fi

  attempt=1
  while [[ "$attempt" -le "$max_attempts" ]]; do
    if curl -fsSL --proto-redir =https "$url" -o "$out"; then
      return 0
    fi
    if [[ "$attempt" -eq "$max_attempts" ]]; then
      return 1
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  return 1
}

download() {
  local filename="$1"
  local url="${DOWNLOAD_BASE}/${filename}"

  if [[ "$skip_existing" == true && -e "$filename" ]]; then
    echo "Using local ${filename}"
    return 0
  fi

  temporary_file=$(mktemp "./${filename}.tmp.XXXXXX")
  if ! curl_download "$url" "$temporary_file"; then
    fail "could not download ${filename} from ${url}."
  fi
  mv -- "$temporary_file" "$filename"
  temporary_file=""
}

create_env() {
  umask 077
  temporary_file=$(mktemp "./${ENV_FILE}.tmp.XXXXXX")

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "POSTGRES_PASSWORD=")
        printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 16)"
        ;;
      "BETTER_AUTH_SECRET=")
        printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
        ;;
      "ENCRYPTION_KEY=")
        printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
        ;;
      "SCREEN_PROXY_SECRET=")
        printf 'SCREEN_PROXY_SECRET=%s\n' "$(openssl rand -hex 32)"
        ;;
      "SANDBOX_SUPERVISOR_TOKEN=")
        printf 'SANDBOX_SUPERVISOR_TOKEN=%s\n' "$(openssl rand -hex 32)"
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done < "$ENV_EXAMPLE" > "$temporary_file"

  chmod 600 "$temporary_file"
  mv -- "$temporary_file" "$ENV_FILE"
  temporary_file=""
  echo "Created .env with random secrets."
}

validate_required_secrets() {
  if ! docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f - config --environment <<'YAML' | awk '
    BEGIN {
      required["POSTGRES_PASSWORD"] = 1
      required["BETTER_AUTH_SECRET"] = 1
      required["ENCRYPTION_KEY"] = 1
      required["SCREEN_PROXY_SECRET"] = 1
      required["SANDBOX_SUPERVISOR_TOKEN"] = 1
    }
    {
      name = $0
      sub(/=.*/, "", name)
      if (!(name in required)) next
      seen[name]++

      value = $0
      sub(/^[^=]*=/, "", value)
      gsub(/[[:space:]]/, "", value)
      if (value != "") nonempty[name]++
    }
    END {
      for (name in required) {
        if (seen[name] != 1 || nonempty[name] != 1) exit 1
      }
    }
  '
services:
  api:
    environment:
      _RAKAZO_VALIDATE_POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
      _RAKAZO_VALIDATE_BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?Set BETTER_AUTH_SECRET in .env}
      _RAKAZO_VALIDATE_ENCRYPTION_KEY: ${ENCRYPTION_KEY:?Set ENCRYPTION_KEY in .env}
      _RAKAZO_VALIDATE_SCREEN_PROXY_SECRET: ${SCREEN_PROXY_SECRET:?Set SCREEN_PROXY_SECRET in .env}
      _RAKAZO_VALIDATE_SANDBOX_SUPERVISOR_TOKEN: ${SANDBOX_SUPERVISOR_TOKEN:?Set SANDBOX_SUPERVISOR_TOKEN in .env}
YAML
  then
    fail "set every required secret in .env to a non-empty value."
  fi
}

download "$COMPOSE_FILE"
download "$ENV_EXAMPLE"

if [[ -e "$ENV_FILE" ]]; then
  echo "Keeping existing .env."
else
  create_env
fi

validate_required_secrets

if [[ "$prepare_only" == true ]]; then
  echo "Rakazo files are ready. Edit .env, then run: bash install-images.sh"
  exit 0
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
# `--wait` without `--wait-timeout` can hang on one-shot services (Compose < 2.7)
# or never return if a healthcheck stays red (Compose < 2.17). Prefer both flags.
compose_up_help=$(docker compose up --help 2>/dev/null || true)
if grep -q -- '--wait-timeout' <<<"$compose_up_help"; then
  echo "Waiting for healthy services."
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --wait --wait-timeout 300
else
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
fi

echo "Rakazo is starting at http://127.0.0.1:5173"
