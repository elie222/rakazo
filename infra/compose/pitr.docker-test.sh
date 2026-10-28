#!/usr/bin/env bash
# Point-in-time recovery against real Docker, through the production Compose file and pitr.sh. An
# S3 stand-in (rclone serve s3, from the sidecar image) holds the uploads. Uses a throwaway Compose
# project and removes everything it creates.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
scratch="$(mktemp -d)"
project="rakazo-pitr-test-$$"
export COMPOSE_PROJECT_NAME="${project}"
bucket=rakazo-pitr-test
fail() {
  echo "FAIL: $*" >&2
  sql "SELECT now(), pg_walfile_name(pg_current_wal_lsn()), timeline_id FROM pg_control_checkpoint()" >&2 || true
  sql "SELECT slot_name, active, restart_lsn, wal_status FROM pg_replication_slots" >&2 || true
  sql "SELECT state, sent_lsn, write_lsn, flush_lsn FROM pg_stat_replication" >&2 || true
  "${compose[@]}" --profile pitr exec -T pitr sh -c 'ls -lR /var/lib/rakazo-pitr; ps -eo pid,args' >&2 || true
  [[ -z "${archive:-}" ]] || docker exec "${s3}" ls -l "${archive}/wal" >&2 || true
  "${compose[@]}" --profile pitr logs --no-color --tail 40 pitr >&2 || true
  "${compose[@]}" logs --no-color --tail 20 postgres >&2 || true
  exit 1
}

mkdir -p "${scratch}/infra/compose"
cp "${root}/docker-compose.prod.yml" "${root}/Dockerfile.pitr" "${root}/pitr-agent.sh" "${root}/pitr.sh" \
  "${scratch}/infra/compose/"
cat >"${scratch}/.env" <<'ENV'
POSTGRES_PASSWORD=owner-test-password
POSTGRES_APP_PASSWORD=app-test-password
SCREEN_PROXY_SECRET=test-screen-proxy-secret-0123456789abcdef
ENV
compose=(docker compose --env-file "${scratch}/.env" -f "${scratch}/infra/compose/docker-compose.prod.yml")
s3="${project}-s3"
volumes=("${project}_restored" "${project}_latest")
cleanup() {
  docker rm -f "${s3}" "${project}-check" >/dev/null 2>&1 || true
  "${compose[@]}" --profile pitr down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker volume rm -f "${volumes[@]}" >/dev/null 2>&1 || true
  rm -rf "${scratch}"
}
trap cleanup EXIT

pitr() { RAKAZO_DEPLOY_DIR="${scratch}" bash "${scratch}/infra/compose/pitr.sh" "$@"; }
# Restores run in a plain container on Docker's default network, as they would on another machine,
# with only the storage settings in their own file.
restore() { PITR_ENV_FILE="${scratch}/restore.env" pitr "$@" <"${scratch}/identity"; }
sql() { "${compose[@]}" exec -T postgres psql -X -At -v ON_ERROR_STOP=1 -U rakazo -d rakazo -c "$1"; }
wait_for() {
  local what="$1" deadline=$((SECONDS + 180))
  shift
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || fail "timed out waiting for ${what}"
    sleep 2
  done
}
# Rows in a restored volume, read by a plain Postgres on it.
rows_in() {
  docker run -d --name "${project}-check" -e POSTGRES_PASSWORD=unused -v "$1:/var/lib/postgresql" \
    --entrypoint docker-entrypoint.sh "${image}" postgres >/dev/null
  wait_for "the restored database" docker exec "${project}-check" pg_isready -h 127.0.0.1 -U rakazo -d rakazo
  docker exec "${project}-check" psql -X -At -h 127.0.0.1 -U rakazo -d rakazo -c "SELECT count(*), max(id) FROM t"
  docker rm -f "${project}-check" >/dev/null
}

# Off by default: no sidecar, and Postgres keeps its stock WAL settings.
"${compose[@]}" config --services | grep -qx pitr && fail "pitr runs without its profile"
"${compose[@]}" up -d --wait --quiet-pull postgres >/dev/null
[[ "$(sql "SHOW archive_timeout")" == 0 ]] || fail "archive_timeout is set by default"
[[ "$(sql "SELECT count(*) FROM pg_replication_slots")" == 0 ]] || fail "a replication slot exists by default"
pitr enable >/dev/null 2>&1 && fail "enable passed without settings"
[[ "$(sql "SELECT count(*) FROM pg_roles WHERE rolname = 'rakazo_pitr'")" == 0 ]] ||
  fail "a refused enable created the replication login"

"${compose[@]}" --profile pitr build --quiet pitr
image="$("${compose[@]}" --profile pitr config --images | grep '^rakazo-pitr:')"
docker run -d --name "${s3}" --entrypoint rclone "${image}" \
  serve s3 --auth-key test-access-key,test-secret-key --addr :9000 /tmp/s3 >/dev/null
docker network connect --alias s3 "${project}_data" "${s3}"
s3_address="$(docker inspect -f '{{.NetworkSettings.Networks.bridge.IPAddress}}' "${s3}")"
docker exec "${s3}" mkdir -p "/tmp/s3/${bucket}"
docker run --rm --entrypoint age-keygen "${image}" >"${scratch}/identity" 2>/dev/null
recipient="$(docker run --rm -i --entrypoint age-keygen "${image}" -y <"${scratch}/identity")"
cat >>"${scratch}/.env" <<ENV
PITR_DATABASE_PASSWORD=0123456789abcdef0123456789abcdef
PITR_BUCKET=${bucket}
PITR_ENDPOINT=http://s3:9000
PITR_REGION=us-east-1
PITR_ACCESS_KEY_ID=test-access-key
PITR_SECRET_ACCESS_KEY=test-secret-key
PITR_PREFIX=prod
PITR_PATH_STYLE=true
PITR_AGE_RECIPIENTS=${recipient}
ENV
output="$(pitr enable 2>&1)" && fail "enable passed without the pitr profile"
grep -q "COMPOSE_PROFILES" <<<"${output}" || fail "unexpected refusal: ${output}"
echo "COMPOSE_PROFILES=pitr" >>"${scratch}/.env"
grep '^PITR_' "${scratch}/.env" | grep -v '^PITR_ENDPOINT=' >"${scratch}/restore.env"
echo "PITR_ENDPOINT=http://${s3_address}:9000" >>"${scratch}/restore.env"

# Enabling reloads Postgres instead of restarting it.
started="$(sql "SELECT pg_postmaster_start_time()")"
pitr enable >/dev/null
[[ "$(sql "SELECT pg_postmaster_start_time()")" == "${started}" ]] || fail "enable restarted Postgres"
[[ "$(sql "SHOW archive_timeout")" == 1min ]] || fail "archive_timeout was not set"
sysid="$(sql "SELECT system_identifier FROM pg_control_system()")"
archive="/tmp/s3/${bucket}/prod/${sysid}"
has_base() { docker exec "${s3}" sh -c "grep -lx 'timeline=$1' ${archive}/base/*/COMPLETE"; }
wait_for "the first base backup" has_base 1
wait_for "a healthy sidecar" "${compose[@]}" exec -T pitr rakazo-pitr health

# Writes before and after the target time; only the first two batches may come back.
sql "CREATE TABLE t (id integer PRIMARY KEY); INSERT INTO t SELECT generate_series(1, 100)" >/dev/null
sql "INSERT INTO t SELECT generate_series(101, 200)" >/dev/null
sleep 1
target="$(sql "SELECT now()")"
sleep 1
sql "INSERT INTO t SELECT generate_series(201, 250)" >/dev/null
# A sidecar restart mid-segment resumes from the slot without a gap.
"${compose[@]}" restart pitr >/dev/null
sql "INSERT INTO t SELECT generate_series(251, 300)" >/dev/null
segment="$(sql "SELECT pg_walfile_name(pg_current_wal_lsn())")"
sql "SELECT pg_switch_wal()" >/dev/null
wait_for "the last segment upload" docker exec "${s3}" test -s "${archive}/wal/${segment}.gz.age"
[[ "$(docker exec "${s3}" head -c 21 "${archive}/wal/${segment}.gz.age")" == "age-encryption.org/v1" ]] ||
  fail "WAL was uploaded unencrypted"
for file in $(docker exec "${s3}" sh -c "ls ${archive}/base/*/base.tar.zst.age"); do
  [[ "$(docker exec "${s3}" head -c 21 "${file}")" == "age-encryption.org/v1" ]] || fail "a base backup is unencrypted"
done

restore restore "${target}" "${project}_restored" >/dev/null
[[ "$(rows_in "${project}_restored")" == "200|200" ]] || fail "restoring to ${target} did not return exactly the first 200 rows"
restore restore latest "${project}_latest" >/dev/null
[[ "$(rows_in "${project}_latest")" == "300|300" ]] || fail "restoring the latest point lost rows"
restore drill | grep -q "^Drill passed" || fail "the drill did not pass"
output="$(restore restore "2000-01-01 00:00:00+00" "${project}_restored" 2>&1)" &&
  fail "a restore before the first base backup passed"
grep -q "earliest recoverable time" <<<"${output}" || fail "unexpected restore failure: ${output}"

# The production procedure: restore in place, then archiving resumes on the new timeline.
"${compose[@]}" stop pitr postgres >/dev/null
restore restore "${target}" "${project}_postgres" >/dev/null
"${compose[@]}" up -d --wait postgres pitr >/dev/null
[[ "$(sql "SELECT count(*) FROM t")" == 200 ]] || fail "the in-place restore did not return 200 rows"
# shellcheck disable=SC2016 # expanded inside the container
"${compose[@]}" exec -T postgres sh -c 'ls -d "$PGDATA".before-restore-*' >/dev/null ||
  fail "the replaced cluster was not kept"
wait_for "a base backup on the new timeline" has_base 2
wait_for "a healthy sidecar after restore" "${compose[@]}" exec -T pitr rakazo-pitr health
docker exec "${s3}" test -s "${archive}/wal/00000002.history.gz.age" || fail "the new timeline's history was not archived"
sql "INSERT INTO t SELECT generate_series(1001, 1010)" >/dev/null
segment="$(sql "SELECT pg_walfile_name(pg_current_wal_lsn())")"
# No manual switch here: archive_timeout alone must close the segment within about a minute.
wait_for "the new timeline's segment upload" docker exec "${s3}" test -s "${archive}/wal/${segment}.gz.age"
docker volume rm -f "${project}_latest" >/dev/null
restore restore latest "${project}_latest" >/dev/null
[[ "$(rows_in "${project}_latest")" == "210|1010" ]] || fail "writes after the restore were not archived"
# Creating the slot must not start a second base backup beside the first.
for timeline in 1 2; do
  [[ "$(has_base "${timeline}" | wc -l)" -eq 1 ]] || fail "timeline ${timeline} has more than one base backup"
done

# Disabling releases everything Postgres held for the sidecar.
sed -i.bak '/^COMPOSE_PROFILES=/d' "${scratch}/.env"
pitr disable >/dev/null
[[ "$(sql "SELECT count(*) FROM pg_replication_slots")" == 0 ]] || fail "disable left the replication slot"
[[ "$(sql "SHOW archive_timeout")" == 0 ]] || fail "disable left archive_timeout"
[[ "$(sql "SELECT count(*) FROM pg_roles WHERE rolname = 'rakazo_pitr'")" == 0 ]] || fail "disable left the login"
# shellcheck disable=SC2016
"${compose[@]}" exec -T postgres sh -c 'grep -q rakazo_pitr "$PGDATA/pg_hba.conf"' &&
  fail "disable left the pg_hba.conf line"
echo "pitr: ok"
