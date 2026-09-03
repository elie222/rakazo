#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
g() { grep -F -e "$1" "$src" >/dev/null || fail "missing $1"; }
g 'sync_curl_proxy_env'
g 'export http_proxy="$HTTP_PROXY"'
g 'export https_proxy="$HTTPS_PROXY"'
g 'export no_proxy="$NO_PROXY"'
g 'could not pull images'
g 'registry-mirrors'
g 'Set HTTP_PROXY/HTTPS_PROXY'
g 'NO_PROXY for localhost'
g '--pull never'
bash -n "$src" || fail "bash -n"

# Unit: source only the sync function
eval "$(awk '
  /^sync_curl_proxy_env\(\) \{/ { p=1 }
  p { print }
  p && /^\}/ { exit }
' "$src")"
unset http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY || true
HTTP_PROXY='http://proxy.example:8080'
HTTPS_PROXY='http://proxy.example:8443'
NO_PROXY='localhost,127.0.0.1'
sync_curl_proxy_env
[[ "$http_proxy" == "$HTTP_PROXY" ]] || fail "http_proxy not synced"
[[ "$https_proxy" == "$HTTPS_PROXY" ]] || fail "https_proxy not synced"
[[ "$no_proxy" == "$NO_PROXY" ]] || fail "no_proxy not synced"
# do not clobber explicit lowercase
http_proxy='http://already:1'
HTTP_PROXY='http://upper:1'
sync_curl_proxy_env
[[ "$http_proxy" == 'http://already:1' ]] || fail "clobbered existing http_proxy"
echo "ok"
