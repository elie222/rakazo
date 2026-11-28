#!/usr/bin/env bash
set -euo pipefail

# Render names the service's public address only at runtime. A custom domain is set in
# BETTER_AUTH_URL, which the other origins follow.
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-${RENDER_EXTERNAL_URL:?Render did not set RENDER_EXTERNAL_URL}}"
export WEB_ORIGIN="${WEB_ORIGIN:-$BETTER_AUTH_URL}"
export API_URL="${API_URL:-$BETTER_AUTH_URL}"
host="${BETTER_AUTH_URL#*://}"
export RAKAZO_HOST="${RAKAZO_HOST:-${host%%[:/]*}}"
if [[ -n "${RENDER_EXTERNAL_HOSTNAME:-}" ]]; then
  export RAKAZO_ALLOWED_HOSTS="${RAKAZO_ALLOWED_HOSTS:+$RAKAZO_ALLOWED_HOSTS,}$RENDER_EXTERNAL_HOSTNAME"
fi
# Render's edge appends to a caller's own X-Forwarded-For; True-Client-IP is the address it saw.
export CLIENT_IP_HEADER="${CLIENT_IP_HEADER:-true-client-ip}"
export SANDBOX_PROVIDER="${SANDBOX_PROVIDER:-}"

exec bash "$(dirname "$0")/../railway/start.sh" migrate render
