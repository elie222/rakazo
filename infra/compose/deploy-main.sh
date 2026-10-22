#!/usr/bin/env bash
# Build and roll out origin/main on the single-VM production stack.
#
# Runs as the deploy user through deploy-launcher.sh, which is installed as the CI forced command
# and always runs this file from origin/main. The deploy user needs passwordless sudo for Docker.
set -Eeuo pipefail

# A forced SSH command carries no environment, so read the checkout path from a root-owned file.
if [[ -z "${RAKAZO_DEPLOY_DIR:-}" && -r /etc/rakazo/deploy.env ]]; then
  # shellcheck disable=SC1091
  source /etc/rakazo/deploy.env
fi
APP_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
[[ "${APP_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }
COMPOSE_FILE="infra/compose/docker-compose.prod.yml"
# CI allows 30 minutes: 15m build + 5m start + ~1m of health retries + 8m rollback.
BUILD_TIMEOUT="${RAKAZO_DEPLOY_BUILD_TIMEOUT:-15m}"
UP_TIMEOUT="${RAKAZO_DEPLOY_UP_TIMEOUT:-5m}"
ROLLBACK_TIMEOUT="${RAKAZO_DEPLOY_ROLLBACK_TIMEOUT:-8m}"
# Free disk a deploy needs before it builds.
MIN_FREE_GB="${RAKAZO_DEPLOY_MIN_FREE_GB:-5}"
BUILD_CACHE_GB="${RAKAZO_DEPLOY_BUILD_CACHE_GB:-8}"
[[ "${BUILD_CACHE_GB}" =~ ^[0-9]+$ ]] || { echo "RAKAZO_DEPLOY_BUILD_CACHE_GB must be a whole number" >&2; exit 1; }
[[ "${MIN_FREE_GB}" =~ ^(0|[1-9][0-9]*)$ ]] || { echo "RAKAZO_DEPLOY_MIN_FREE_GB must be a whole number" >&2; exit 1; }

cd "${APP_DIR}"
if [[ -z "${RAKAZO_HEALTH_URL:-}" ]]; then
  host="$(sed -n 's/^RAKAZO_HOST=//p' .env | tail -n 1)"
  [[ -n "${host}" ]] || { echo "Set RAKAZO_HOST in .env or RAKAZO_HEALTH_URL" >&2; exit 1; }
  RAKAZO_HEALTH_URL="https://${host}/health"
fi

compose() {
  local limit="$1"
  shift
  timeout --kill-after=30s "${limit}" sudo docker compose --env-file .env -f "${COMPOSE_FILE}" "$@"
}

healthy() {
  curl --fail --silent --show-error --max-time 15 "${RAKAZO_HEALTH_URL}" >/dev/null
}

# Waits for a container's own health check, or for it to run when its revision has none (a
# rollback can restore one). A container that fails is removed so the containers it was meant to
# replace keep serving.
container_healthy() {
  local container="$1" state="" deadline=$((SECONDS + 300))
  while ((SECONDS < deadline)); do
    # A container that exits keeps its last health status, so check that it still runs.
    state="$(sudo docker inspect --format \
      '{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}}' "${container}")"
    case "${state}" in
      "running healthy" | running) return 0 ;;
      "running starting" | created*) ;;
      *) break ;;
    esac
    sleep "${RAKAZO_DEPLOY_HEALTH_INTERVAL:-1}"
  done
  echo "Container ${container} did not become healthy (${state:-unknown})." >&2
  sudo docker rm --force "${container}" >/dev/null || true
  return 1
}

# Replaces the API and web without a gap: one new container starts beside the running ones, and
# the old ones stop only once it passes its health check. Caddy dials whichever container
# answers, so requests keep flowing through a deploy. Every other service is then reconciled
# normally; the replaced containers already match the new configuration and stay as they are.
roll_out() {
  local service old new
  for service in api web; do
    old="$(compose 1m ps --all --quiet "${service}")"
    if [[ -z "${old}" ]]; then
      # Nothing to keep serving, so start it with its dependencies (the database on a new host).
      compose "${UP_TIMEOUT}" up -d --wait "${service}"
      continue
    fi
    compose "${UP_TIMEOUT}" up -d --no-deps --no-recreate \
      --scale "${service}=$(($(wc -w <<<"${old}") + 1))" "${service}"
    new="$(compose 1m ps --all --quiet "${service}" | grep -vxF "${old}")"
    container_healthy "${new}"
    # shellcheck disable=SC2086 # one container ID per word
    sudo docker stop --time 30 ${old} >/dev/null
    # shellcheck disable=SC2086
    sudo docker rm ${old} >/dev/null
  done
  compose "${UP_TIMEOUT}" up -d --remove-orphans
}

# Caddy mounts its config as a single file, which keeps the old inode after a git checkout, so a
# changed Caddyfile only applies when the container is recreated.
apply_caddyfile() {
  if ! git diff --quiet "$1" "$2" -- infra/compose/Caddyfile.prod; then
    compose "${UP_TIMEOUT}" up -d --no-deps --force-recreate caddy
  fi
}

exec 9>"${APP_DIR}/.deploy.lock"
if ! flock -n 9; then
  # CI runs one deploy at a time, so a held lock means an earlier deploy is stuck. Fail loudly
  # instead of reporting a deploy that never happened.
  echo "Another production deployment holds the lock; refusing to report success." >&2
  exit 1
fi

# Each build adds images, so refuse to start one that would fill the disk. Check before fetching:
# git fails on a full disk with a less helpful message.
docker_root="$(sudo docker info --format '{{.DockerRootDir}}')"
for dir in "${APP_DIR}" "${docker_root}"; do
  free_gb="$(df -Pk "${dir}" | awk 'NR == 2 { print int($4 / 1048576) }')"
  if ((free_gb < MIN_FREE_GB)); then
    echo "Only ${free_gb}GB free on ${dir}; deploys need ${MIN_FREE_GB}GB (RAKAZO_DEPLOY_MIN_FREE_GB)." >&2
    echo "Free space first, for example: sudo docker image prune -f && sudo docker builder prune -f" >&2
    exit 1
  fi
done

previous_revision="$(git rev-parse HEAD)"
git fetch --quiet --prune origin main
# The launcher pins the commit its copy of this script came from.
target_revision="$(git rev-parse --verify "${RAKAZO_DEPLOY_REVISION:-origin/main}^{commit}")"

# Written only after a healthy rollout. A reset can make HEAD match before containers change.
deployed_revision=""
if [[ -r "${APP_DIR}/.last-deployed-revision" ]]; then
  deployed_revision="$(tr -d '[:space:]' <"${APP_DIR}/.last-deployed-revision")"
fi
if [[ "${previous_revision}" == "${target_revision}" && "${deployed_revision}" == "${target_revision}" ]] && healthy; then
  echo "Production is already at ${target_revision} and healthy."
  exit 0
fi

rollback() {
  trap - ERR
  echo "Deployment failed; restoring the previous revision ${previous_revision}." >&2
  git reset --hard "${previous_revision}"
  compose "${ROLLBACK_TIMEOUT}" build
  roll_out
  apply_caddyfile "${target_revision}" "${previous_revision}"
  exit 1
}
trap rollback ERR

# Image IDs the running containers use, kept after the deploy for a manual rollback.
previous_images="$(compose 1m images -q 2>/dev/null | sort -u)" || previous_images="unknown"

# Runs after a healthy rollout. Tags the previous images so they survive, then drops untagged
# images and trims the build cache to a fixed size (RAKAZO_DEPLOY_BUILD_CACHE_GB, default 8): a
# time window let a busy day of deploys pile up tens of gigabytes. Cleanup is time-limited and
# never fails the deploy.
prune_docker() {
  local id kept=true
  if [[ "${previous_images}" == unknown ]]; then
    kept=false
  else
    # Untag by name only: removing by ID would also drop the tag of an image still in use.
    sudo docker image ls --format '{{.Repository}}:{{.Tag}}' rakazo-rollback |
      xargs -r sudo docker rmi >/dev/null 2>&1 || true
    for id in ${previous_images}; do
      sudo docker tag "${id}" "rakazo-rollback:${id#sha256:}" || kept=false
    done
  fi
  if [[ "${kept}" == true ]]; then
    timeout 5m sudo docker image prune --force >/dev/null || echo "Image prune failed; continuing." >&2
  else
    echo "Could not tag the previous images; skipping image prune to keep them." >&2
  fi
  timeout 5m sudo docker builder prune --force --keep-storage "${BUILD_CACHE_GB}GB" >/dev/null ||
    echo "Build cache prune failed; continuing." >&2
}

git reset --hard "${target_revision}"
# The app's own database login (subject to row-level security) needs a password
# that older .env files do not have. Appending one leaves existing lines alone.
if ! grep -Eq '^POSTGRES_APP_PASSWORD=[^[:space:]]' .env; then
  printf '\nPOSTGRES_APP_PASSWORD=%s\n' "$(openssl rand -hex 16)" >>.env
  echo "Added POSTGRES_APP_PASSWORD to .env."
fi
compose 1m config --quiet
compose "${BUILD_TIMEOUT}" build
roll_out
apply_caddyfile "${previous_revision}" "${target_revision}"

for _ in {1..30}; do
  if healthy; then
    printf '%s\n' "${target_revision}" >"${APP_DIR}/.last-deployed-revision"
    trap - ERR
    prune_docker
    echo "Deployed ${target_revision} successfully."
    exit 0
  fi
  sleep "${RAKAZO_DEPLOY_HEALTH_INTERVAL:-2}"
done

echo "Production health check did not recover in time." >&2
false
