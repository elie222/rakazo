#!/usr/bin/env bash
# Roll out origin/main on the single-VM production stack.
#
# Runs as the deploy user through deploy-launcher.sh, which is installed as the CI forced command
# and always runs this file from origin/main. The deploy user needs passwordless sudo for Docker.
#
# CI publishes the app image for a main commit before it deploys that commit, so this pulls
# <RAKAZO_DEPLOY_IMAGE>:sha-<commit> instead of building on the host that serves traffic. It builds
# the checkout instead when the pull fails or times out, or when no image repository is configured.
set -Eeuo pipefail

# A forced SSH command carries no environment, so read the checkout path from a root-owned file.
if [[ -z "${RAKAZO_DEPLOY_DIR:-}" && -r /etc/rakazo/deploy.env ]]; then
  # shellcheck disable=SC1091
  source /etc/rakazo/deploy.env
fi
APP_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
[[ "${APP_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }
COMPOSE_FILE="infra/compose/docker-compose.prod.yml"
# CI allows 140 minutes: 5m pull + 15m fallback build + 5m start + ~1m of health retries + 8m
# rollback, which only pulls or builds when the previous image is gone, + up to 50m (the worker's
# stop_grace_period) twice: for a worker an earlier deploy left draining, then for this one's. The
# replaced API's few minutes of draining run alongside the worker's.
PULL_TIMEOUT="${RAKAZO_DEPLOY_PULL_TIMEOUT:-5m}"
BUILD_TIMEOUT="${RAKAZO_DEPLOY_BUILD_TIMEOUT:-15m}"
UP_TIMEOUT="${RAKAZO_DEPLOY_UP_TIMEOUT:-5m}"
ROLLBACK_TIMEOUT="${RAKAZO_DEPLOY_ROLLBACK_TIMEOUT:-8m}"
# Longer than a replaced API takes to stop: its HTTP drain, RUN_DRAIN_MS, then handing back.
API_DRAIN_TIMEOUT=6m
# Free disk a deploy needs before it pulls or builds.
MIN_FREE_GB="${RAKAZO_DEPLOY_MIN_FREE_GB:-5}"
BUILD_CACHE_GB="${RAKAZO_DEPLOY_BUILD_CACHE_GB:-8}"
[[ "${BUILD_CACHE_GB}" =~ ^[0-9]+$ ]] || { echo "RAKAZO_DEPLOY_BUILD_CACHE_GB must be a whole number" >&2; exit 1; }
[[ "${MIN_FREE_GB}" =~ ^(0|[1-9][0-9]*)$ ]] || { echo "RAKAZO_DEPLOY_MIN_FREE_GB must be a whole number" >&2; exit 1; }

cd "${APP_DIR}"
# Where CI publishes the app image. Unset: the GHCR app image of the GitHub repository the checkout
# tracks, which is where publish-server-image.yml pushes. Empty: always build on the host.
if [[ -z "${RAKAZO_DEPLOY_IMAGE+set}" ]]; then
  RAKAZO_DEPLOY_IMAGE=""
  origin_url="$(git config --get remote.origin.url || true)"
  if [[ "${origin_url}" =~ github\.com[:/]([^/]+/[^/]+)$ ]]; then
    repository="$(tr '[:upper:]' '[:lower:]' <<<"${BASH_REMATCH[1]%.git}")"
    RAKAZO_DEPLOY_IMAGE="ghcr.io/${repository}/app"
  fi
fi
if [[ -z "${RAKAZO_HEALTH_URL:-}" ]]; then
  host="$(sed -n 's/^RAKAZO_HOST=//p' .env | tail -n 1)"
  [[ -n "${host}" ]] || { echo "Set RAKAZO_HOST in .env or RAKAZO_HEALTH_URL" >&2; exit 1; }
  RAKAZO_HEALTH_URL="https://${host}/health"
fi

# How many API and worker containers to run, the same .env settings Compose reads.
replicas() {
  local count
  count="$(sed -n "s/^$1=//p" .env | tail -n 1)"
  echo "${count:-1}"
}
API_REPLICAS="$(replicas RAKAZO_API_REPLICAS)"
WORKER_REPLICAS="$(replicas RAKAZO_WORKER_REPLICAS)"
for count in "${API_REPLICAS}" "${WORKER_REPLICAS}"; do
  [[ "${count}" =~ ^[1-9][0-9]*$ ]] || { echo "RAKAZO_API_REPLICAS and RAKAZO_WORKER_REPLICAS must be whole numbers of at least 1" >&2; exit 1; }
done

compose() {
  local limit="$1"
  shift
  timeout --kill-after=30s "${limit}" sudo docker compose --env-file .env -f "${COMPOSE_FILE}" "$@"
}

healthy() {
  curl --fail --silent --show-error --max-time 15 "${RAKAZO_HEALTH_URL}" >/dev/null
}

# The image the api, web and worker share, as Compose resolves it from .env (by default
# ghcr.io/<owner>/<repo>/app:local). A pulled image is tagged as it, so hand-run Compose commands
# and backups keep using whatever the deploy started.
compose_app_image() {
  compose 1m config | awk '
    $0 == "  api:" { api = 1; next }
    api && /^  [^ ]/ { api = 0 }
    api && /^    image: / { print $2; api = 0 }'
}

# Points the app image at the published image for a revision, or builds that revision when the
# image cannot be pulled, so a registry outage slows a deploy down instead of blocking it.
use_revision_image() {
  local revision="$1" limit="$2" published
  if [[ -n "${RAKAZO_DEPLOY_IMAGE}" ]]; then
    published="${RAKAZO_DEPLOY_IMAGE}:sha-${revision}"
    if timeout --kill-after=30s "${PULL_TIMEOUT}" sudo docker pull --quiet "${published}" >/dev/null; then
      sudo docker tag "${published}" "${app_image}"
      # Drop the sha- tag; the image stays as the app image, so these tags never pile up.
      sudo docker rmi "${published}" >/dev/null || true
      echo "Using the published image ${published}."
      return 0
    fi
    echo "::warning::Could not pull ${published}; building ${revision} on this host instead, with the default email copy." >&2
  fi
  compose "${limit}" build --build-arg "GIT_SHA=${revision}"
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

# Starts the given number of new containers of a service beside the running ones and waits for
# their health checks.
start_beside() {
  local service="$1" running="$2" count="$3" new container
  compose "${UP_TIMEOUT}" up -d --no-deps --no-recreate \
    --scale "${service}=$(($(wc -w <<<"${running}") + count))" "${service}"
  new="$(compose 1m ps --all --quiet "${service}" | grep -vxF "${running}")"
  for container in ${new}; do
    container_healthy "${container}"
  done
}

# A replaced worker is not stopped like the web container. It stops claiming jobs and finishes the
# ones it is running, which can take as long as the slowest job (JOB_DRAIN_TIMEOUT_MS), while the
# new worker takes new ones; killing it would leave each job locked for hours. The runs it is
# executing get a few minutes to end their turn (RUN_DRAIN_MS). A replaced API does the same with
# its chat turns once it has stopped taking requests (see retire_api). A restart policy of "no"
# keeps Docker from starting one again and marks it as draining for later runs. Prints the
# containers of a service that are live (not draining), serving (live and running), or draining
# (still finishing, or exited and not yet removed).
service_containers() {
  local ids
  ids="$(compose 1m ps --all --quiet "$1")"
  [[ -n "${ids}" ]] || return 0
  # shellcheck disable=SC2086 # one container ID per word
  sudo docker inspect --format '{{.Id}} {{.HostConfig.RestartPolicy.Name}} {{.State.Running}}' ${ids} |
    awk -v wanted="$2" '
      $2 == "no" && wanted == "draining" { print $1 }
      $2 != "no" && wanted == "live" { print $1 }
      $2 != "no" && $3 == "true" && wanted == "serving" { print $1 }'
}

# Waits for draining containers to exit and removes them, the worker's and then the API's unless
# one service is named. docker stop gives a worker the rest of its stop_grace_period before it
# kills one. An API hands back what is still running at RUN_DRAIN_MS and exits by itself; one still
# there after API_DRAIN_TIMEOUT is stopped as before.
finish_draining() {
  local workers="" apis=""
  [[ "${1:-worker}" != worker ]] || workers="$(service_containers worker draining)"
  if [[ -n "${workers}" ]]; then
    echo "Waiting for the previous worker to finish its running jobs."
    # shellcheck disable=SC2086
    sudo docker stop ${workers} >/dev/null
    # shellcheck disable=SC2086
    sudo docker rm ${workers} >/dev/null
  fi
  [[ "${1:-api}" != api ]] || apis="$(service_containers api draining)"
  if [[ -n "${apis}" ]]; then
    echo "Waiting for the previous API to finish its chat turns."
    # shellcheck disable=SC2086
    timeout "${API_DRAIN_TIMEOUT}" sudo docker wait ${apis} >/dev/null || true
    stop_containers "${apis}"
  fi
}

# Stops containers the way a deploy always has: whatever runs they hold is handed back at once.
stop_containers() {
  # shellcheck disable=SC2086 # one container ID per word
  sudo docker stop --time 30 $1 >/dev/null
  # shellcheck disable=SC2086
  sudo docker rm $1 >/dev/null
}

drain_containers() {
  # shellcheck disable=SC2086 # one container ID per word
  sudo docker update --restart no $1 >/dev/null
  # One that is not running has nothing to finish; finish_draining removes it.
  # shellcheck disable=SC2086
  sudo docker kill --signal "$2" $1 >/dev/null 2>&1 || true
}

# A replaced API stops taking requests at once (Caddy sets aside an upstream that refuses
# connections and retries another) but lets the chat turns it is running end, on the signal its
# image names. One from a release without that label is stopped as before.
retire_api() {
  local container signal
  for container in $1; do
    signal="$(sudo docker inspect --format '{{index .Config.Labels "org.rakazo.run-drain-signal"}}' "${container}")"
    if [[ -n "${signal}" ]]; then
      drain_containers "${container}" "${signal}"
    else
      stop_containers "${container}"
    fi
  done
}

replace_worker() {
  local live
  live="$(service_containers worker live)"
  if [[ -n "$(service_containers worker draining)" ]]; then
    # Only a rollback finds a worker still draining: the one its deploy replaced. The failed
    # release's worker stops claiming jobs too, and the restored one starts once both exit,
    # because a scale-up would also start a drained worker that exited in the meantime.
    [[ -z "${live}" ]] || drain_containers "${live}" SIGTERM
    finish_draining worker
    live=""
  fi
  # No bare return: inside the rollback, which runs from the ERR trap, bash before 5.3 returns the
  # status of the command that failed the deploy, and errexit then ends the rollback here.
  if [[ -z "${live}" ]]; then
    compose "${UP_TIMEOUT}" up -d --no-deps --wait worker
  else
    start_beside worker "${live}" "${WORKER_REPLICAS}"
    drain_containers "${live}" SIGTERM
  fi
}

# Replaces the API, web and worker without a gap: new containers start beside the running
# ones, and the old ones stop only once those pass their health checks. Caddy dials whichever container
# answers, so requests keep flowing through a deploy. The old API and worker end the turns they
# were executing or, past RUN_DRAIN_MS, hand them back. Every other service is then reconciled
# normally; the replaced containers already match the new configuration and stay as they are.
# Compose leaves the API and worker alone there, since it would stop a draining one.
roll_out() {
  local service old services draining others
  # Migrations run first, from their own container: it is the only one given the owner login.
  # The old API keeps serving meanwhile, so each migration must work with the previous release.
  # On older releases the API migrates on start, so only start its database here.
  # grep -q would exit at the first match and SIGPIPE compose, which pipefail reads as no match.
  services="$(compose 1m config --services)"
  if grep -qx migrate <<<"${services}"; then
    compose "${UP_TIMEOUT}" run --rm -T -e "RAKAZO_DEPLOYED_MIGRATIONS=${deployed_migrations}" migrate
  else
    compose "${UP_TIMEOUT}" up -d --wait postgres
  fi
  for service in api web; do
    if [[ "${service}" == api ]]; then
      # Only a rollback finds an API still draining: the one its deploy replaced, which Compose
      # would count, or start again if it has exited. Its turns are handed back now.
      draining="$(service_containers api draining)"
      [[ -z "${draining}" ]] || stop_containers "${draining}"
    fi
    old="$(compose 1m ps --all --quiet "${service}")"
    if [[ -z "${old}" ]]; then
      # The migration run already started the database; do not rerun it through dependencies.
      compose "${UP_TIMEOUT}" up -d --no-deps --wait "${service}"
      continue
    fi
    if [[ "${service}" == api ]]; then
      start_beside api "${old}" "${API_REPLICAS}"
      retire_api "${old}"
    else
      start_beside "${service}" "${old}" 1
      stop_containers "${old}"
    fi
  done
  replace_worker
  # A second migration run would consume a deferred drop before the old worker has drained.
  others="$(grep -Ev '^(api|worker|migrate)$' <<<"${services}" || true)"
  # Without services, Compose would reconcile all of them, the draining ones too.
  # shellcheck disable=SC2086 # one service name per word
  [[ -z "${others}" ]] || compose "${UP_TIMEOUT}" up -d --no-deps --remove-orphans ${others}
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

# Each deploy adds an image, so refuse to start one that would fill the disk. Check before
# fetching: git fails on a full disk with a less helpful message.
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

# A failed rollout may have already seen its deferred drops. Only a release that actually ran
# can make those drops safe; retrying it, or skipping to another release, must keep holding them.
# Unknown deployment history fails closed until a successful release records its revision.
deployed_migrations=""
if [[ "${deployed_revision}" =~ ^[[:xdigit:]]{40}$ ]]; then
  deployed_migrations="$(git ls-tree --name-only "${deployed_revision}:packages/db/prisma/migrations" 2>/dev/null | paste -sd, -)" || deployed_migrations=""
fi

app_image=""
# The image the running API uses, which can differ from the configured tag if someone pulled a
# newer one without recreating the containers.
previous_app_image=""
api_container="$(service_containers api serving 2>/dev/null | head -n 1 || true)"
if [[ -n "${api_container}" ]]; then
  previous_app_image="$(sudo docker inspect --format '{{.Image}}' "${api_container}" 2>/dev/null || true)"
fi

rollback() {
  trap - ERR
  echo "Deployment failed; restoring the previous revision ${previous_revision}." >&2
  git reset --hard "${previous_revision}"
  app_image="$(compose_app_image)"
  # The image the previous containers ran is still here, so restoring it is a retag. Without a
  # running API to read it from, pull or build the previous revision instead.
  if [[ -n "${previous_app_image}" ]]; then
    sudo docker tag "${previous_app_image}" "${app_image}"
  else
    use_revision_image "${previous_revision}" "${ROLLBACK_TIMEOUT}"
  fi
  roll_out
  apply_caddyfile "${target_revision}" "${previous_revision}"
  finish_draining || echo "Could not remove the replaced worker; the next deploy will." >&2
  exit 1
}
trap rollback ERR

# Image IDs the running containers use, kept after the deploy for a manual rollback.
previous_images="$(compose 1m images -q 2>/dev/null | sort -u)" || previous_images="unknown"

# Runs after a healthy rollout. Tags the previous images so they survive, then drops untagged
# images, which leaves the current and previous app image. The build cache only grows when a pull
# fell back to a build, and is trimmed to RAKAZO_DEPLOY_BUILD_CACHE_GB (default 8). Cleanup is
# time-limited and never fails the deploy.
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
# Postgres 18 refuses a Postgres 16 volume until upgrade-postgres.sh has copied the data across.
# Stop before anything is replaced rather than take the database down.
# shellcheck disable=SC2016 # expanded inside the container
postgres_state="$(compose "${UP_TIMEOUT}" run --rm --no-deps -T --entrypoint sh postgres -c \
  'if [ ! -s "$PGDATA/PG_VERSION" ] && [ -s /var/lib/postgresql/16/docker/PG_VERSION ]; then echo upgrade; fi')"
if [[ "${postgres_state}" == upgrade ]]; then
  trap - ERR
  git reset --hard "${previous_revision}"
  echo "Postgres needs its one-time upgrade to 18 before this release deploys; see docs/self-host-upgrading.md#upgrading-to-postgres-18." >&2
  exit 1
fi
app_image="$(compose_app_image)"
[[ -n "${app_image}" ]] || { echo "Could not find the api image in ${COMPOSE_FILE}." >&2; false; }
use_revision_image "${target_revision}" "${BUILD_TIMEOUT}"
# A worker still draining from a deploy that stopped early runs code older than the previous
# release, which these migrations need not support.
finish_draining
roll_out
apply_caddyfile "${previous_revision}" "${target_revision}"

for _ in {1..30}; do
  if healthy; then
    printf '%s\n' "${target_revision}" >"${APP_DIR}/.last-deployed-revision"
    trap - ERR
    prune_docker
    # Production already runs the new release; this only holds the next deploy until the
    # replaced worker has finished its jobs.
    finish_draining || echo "Could not remove the replaced worker; the next deploy will." >&2
    echo "Deployed ${target_revision} successfully."
    exit 0
  fi
  sleep "${RAKAZO_DEPLOY_HEALTH_INTERVAL:-2}"
done

echo "Production health check did not recover in time." >&2
false
