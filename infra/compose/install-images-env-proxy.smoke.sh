#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
g() { grep -F -e "$1" "$src" >/dev/null || fail "missing $1"; }
g 'load_proxy_vars_from_env_file'
g 'prepare_proxy_env'
g 'sync_curl_proxy_env'
g 'shell or .env'
bash -n "$src" || fail "bash -n"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
ENV_FILE="$tmp/.env"

eval "$(awk '
  /^load_proxy_vars_from_env_file\(\) \{/ { p=1 }
  /^sync_curl_proxy_env\(\) \{/ { p=1 }
  /^prepare_proxy_env\(\) \{/ { p=1 }
  p { print }
  p && /^\}/ { if (++c==3) exit }
' "$src")"

unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy || true
printf '%s\n' 'HTTP_PROXY="http://fromenv:8080"' 'HTTPS_PROXY=http://fromenv:8443' 'NO_PROXY=localhost' >"$ENV_FILE"
prepare_proxy_env
[[ "$HTTP_PROXY" == "http://fromenv:8080" ]] || fail "HTTP_PROXY from env"
[[ "$http_proxy" == "http://fromenv:8080" ]] || fail "http_proxy synced"
[[ "$HTTPS_PROXY" == "http://fromenv:8443" ]] || fail "HTTPS_PROXY from env"

unset http_proxy || true
HTTP_PROXY='http://shell:9'
printf '%s\n' 'HTTP_PROXY=http://fromenv:1' >"$ENV_FILE"
prepare_proxy_env
[[ "$HTTP_PROXY" == "http://shell:9" ]] || fail "shell should win"
[[ "$http_proxy" == "http://shell:9" ]] || fail "sync from shell"
echo "ok"
