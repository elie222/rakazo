#!/usr/bin/env bash
# Install as /usr/local/sbin/rakazo-deploy-main (the CI forced command). It runs the deploy script
# from origin/main, so deploy changes take effect without reinstalling anything on the host; only
# this launcher is installed, and it rarely changes.
set -Eeuo pipefail

if [[ -z "${RAKAZO_DEPLOY_DIR:-}" && -r /etc/rakazo/deploy.env ]]; then
  # shellcheck disable=SC1091
  source /etc/rakazo/deploy.env
fi
APP_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
[[ "${APP_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }

cd "${APP_DIR}"
git fetch --quiet --prune origin main
# Run it from memory: the deploy resets the checkout, which would rewrite a script file that bash
# is still reading.
# Deploy the commit this script came from, even if main moves before the deploy fetches again.
revision="$(git rev-parse origin/main)"
script="$(git show "${revision}:infra/compose/deploy-main.sh")"
RAKAZO_DEPLOY_REVISION="${revision}" exec bash -c "${script}" rakazo-deploy-main "$@"
