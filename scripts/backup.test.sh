#!/usr/bin/env bash
# Self-test for scripts/backup.sh.
#
# It fakes the two layouts the script has to support and asserts the
# behaviour that matters:
#   1. a source checkout (data in $ROOT/data) archives the data and succeeds;
#   2. a compose deployment (data in a named volume) archives the volume and
#      succeeds;
#   3. NO data source at all FAILS LOUDLY (non-zero exit) instead of writing
#      an empty archive — the 2026-11-05 bug;
#   4. RAKAZO_BACKUP_SKIP_HOMES=1 is still the explicit escape hatch;
#   5. an existing backup directory is never overwritten.
#
# The fakes are shell stubs on PATH: `docker` is replaced, so no daemon and no
# database are needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/backup.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
pass() { printf 'ok   - %s\n' "$*"; }
fail() { printf 'FAIL - %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

[[ -f "$SCRIPT" ]] || { echo "missing $SCRIPT" >&2; exit 1; }

# ---------------------------------------------------------------- stubs
STUB="$WORK/stub"
mkdir -p "$STUB/bin"

# Fake docker. Understands only the calls backup.sh makes.
cat > "$STUB/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -uo pipefail
STATE="${FAKE_DOCKER_STATE:-/dev/null}"
log() { printf '%s\n' "$*" >> "$STATE/docker.log" 2>/dev/null || true; }
log "docker $*"

# Maps a docker volume name to the host directory that fakes it.
volume_dir() {
  if [[ -n "${FAKE_VOLUME:-}" && "$1" == "${FAKE_VOLUME}" ]]; then
    printf '%s\n' "${FAKE_VOLUME_DIR:-}"
  fi
}

case "${1-}" in
  compose)
    shift
    args=("$@")
    for ((i = 0; i < ${#args[@]}; i++)); do
      if [[ "${args[$i]}" == "exec" ]]; then
        j=$((i + 1))
        while [[ "${args[$j]}" == -* ]]; do j=$((j + 1)); done
        service="${args[$j]}"
        cmd=("${args[@]:j+1}")
        log "compose-exec service=$service cmd=${cmd[*]}"
        if [[ "$service" == "postgres" ]]; then
          case "${cmd[*]}" in
            *"pg_dump -U rakazo -Fc"*) printf 'FAKE CUSTOM DUMP\n'; exit 0 ;;
            *"pg_dump -U rakazo"*) printf 'FAKE SQL DUMP\n'; exit 0 ;;
            *"pg_restore --list"*) cat > /dev/null; printf 'fake toc entry\n'; exit 0 ;;
            *"postgres --version"*) printf 'postgres (PostgreSQL) 16.0\n'; exit 0 ;;
            *"pg_dump --version"*) printf 'pg_dump (PostgreSQL) 16.0\n'; exit 0 ;;
            *psql*)
              case "${cmd[*]}" in
                *"count(*) from artifacts"*) printf '%s\n' "${FAKE_ARTIFACT_ROWS:-0}"; exit 0 ;;
                *"storageKey"*) printf '%s\n' "${FAKE_ARTIFACT_KEYS:-}"; exit 0 ;;
              esac
              exit 0 ;;
          esac
        fi
        exit 0
      fi
    done
    # docker compose ps -q
    if [[ "$*" == *"ps -q"* ]]; then
      [[ -n "${FAKE_COMPOSE_CONTAINERS:-}" ]] && printf '%s\n' "$FAKE_COMPOSE_CONTAINERS"
      exit 0
    fi
    exit 0
    ;;
  volume)
    # docker volume inspect NAME
    name="${3-}"
    if [[ -n "${FAKE_VOLUME:-}" && "$name" == "${FAKE_VOLUME}" ]]; then exit 0; fi
    exit 1
    ;;
  run)
    # docker run --rm -v VOL:/data:ro [-v OUT:/out] IMAGE <cmd>
    shift
    vol=""; out=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -v)
          spec="$2"; shift 2
          src="${spec%%:*}"; dst="${spec#*:}"; dst="${dst%%:*}"
          case "$dst" in
            /data) vol="$src" ;;
            /out) out="$src" ;;
          esac
          continue
          ;;
        *) shift ;;
      esac
    done
    log "run vol=$vol out=$out"
    hostdir="$(volume_dir "$vol")"
    if [[ -n "$hostdir" && -n "$out" ]]; then
      # Emulate the volume archive: the script asks the container to write
      # /out/.homes.tgz.tmp and renames it on the host, so the fake has to use
      # the same name.
      ( cd "$(dirname "$hostdir")" && tar -czf "$out/.homes.tgz.tmp" "$(basename "$hostdir")" )
      exit 0
    fi
    if [[ -n "$hostdir" && -d "$hostdir/artifacts" ]]; then
      find "$hostdir/artifacts" -type f | wc -l
      exit 0
    fi
    exit 0
    ;;
  inspect)
    # docker inspect --format {{range .Mounts}}... CONTAINER
    # Mounts are printed in the order the container declares them, and the
    # wrong volume can come first. The resolver must pick the one at /data.
    [[ -n "${FAKE_INSPECT_OTHER_MOUNTS:-}" ]] && printf '%b\n' "${FAKE_INSPECT_OTHER_MOUNTS}"
    [[ -n "${FAKE_INSPECT_MOUNT:-}" ]] && printf '%b\n' "${FAKE_INSPECT_MOUNT}"
    exit 0
    ;;
  ps)
    exit 0
    ;;
esac
exit 0
DOCKER
chmod +x "$STUB/bin/docker"

# A tar stub that can fail on demand, so the test can prove that a failed
# archive does not replace the previous one.
cat > "$STUB/bin/tar" <<'TAR'
#!/usr/bin/env bash
set -eu
if [[ "${1-}" == "-czf" && -n "${FAIL_TAR:-}" ]]; then
  echo "simulated archive read failure" >&2
  exit "$FAIL_TAR"
fi
exec /usr/bin/tar "$@"
TAR
chmod +x "$STUB/bin/tar"

# ---------------------------------------------------------------- helpers
setup_repo() {
  local repo="$1"
  mkdir -p "$repo/scripts/lib" "$repo/infra/compose" "$repo/.state"
  cp "$SCRIPT" "$repo/scripts/backup.sh"
  # backup.sh sources the shared resolver, so the fake repo needs it too.
  cp "$ROOT/scripts/lib/data-source.sh" "$repo/scripts/lib/data-source.sh"
  chmod +x "$repo/scripts/backup.sh"
  : > "$repo/infra/compose/docker-compose.yml"
  printf 'FAKE\n' > "$repo/.env"
}

run_backup() {
  local repo="$1"; shift
  ( cd "$repo" && env \
      PATH="$STUB/bin:$PATH" \
      FAKE_DOCKER_STATE="$repo/.state/docker.log" \
      FAKE_ARTIFACT_ROWS="${FAKE_ARTIFACT_ROWS:-0}" \
      FAKE_ARTIFACT_KEYS="${FAKE_ARTIFACT_KEYS:-}" \
      FAKE_VOLUME="${FAKE_VOLUME:-}" \
      FAKE_VOLUME_DIR="${FAKE_VOLUME_DIR:-}" \
      FAKE_INSPECT_MOUNT="${FAKE_INSPECT_MOUNT:-}" \
      FAKE_COMPOSE_CONTAINERS="${FAKE_COMPOSE_CONTAINERS:-}" \
      FAIL_TAR="${FAIL_TAR:-}" \
      "$repo/scripts/backup.sh" "$@" )
}

# ------------------------------------------------- 1. source checkout layout
REPO="$WORK/checkout"
setup_repo "$REPO"
mkdir -p "$REPO/data/artifacts/space-a" "$REPO/data/homes/bot-a"
printf 'blob1' > "$REPO/data/artifacts/space-a/blob-1"
printf 'blob2' > "$REPO/data/artifacts/space-a/blob-2"
printf 'home' > "$REPO/data/homes/bot-a/file"
export FAKE_ARTIFACT_ROWS=2
export FAKE_ARTIFACT_KEYS="space-a/blob-1
space-a/blob-2"
if out="$(run_backup "$REPO" test1 2>&1)"; then
  pass "source checkout backup succeeds"
else
  fail "source checkout backup succeeds: $out"
fi
[[ -s "$REPO/backups/test1/homes.tgz" ]] && pass "source checkout archive is not empty" \
  || fail "source checkout archive is not empty"
if tar -tzf "$REPO/backups/test1/homes.tgz" 2>/dev/null | grep -q 'data/artifacts/space-a/blob-1'; then
  pass "source checkout archive contains the artifact blob"
else
  fail "source checkout archive contains the artifact blob"
fi
grep -q 'artifact-blob-files-in-archive: 2' "$REPO/backups/test1/MANIFEST" \
  && pass "manifest records the archive blob count" \
  || fail "manifest records the archive blob count"
grep -q 'artifact-rows-without-blob: 0' "$REPO/backups/test1/MANIFEST" \
  && pass "manifest records zero rows without a blob" \
  || fail "manifest records zero rows without a blob"

# ------------------------------------------------ 2. compose volume layout
REPO="$WORK/compose"
setup_repo "$REPO"
VOLROOT="$WORK/volumes"
mkdir -p "$VOLROOT/data/artifacts/space-b" "$VOLROOT/data/homes/bot-b"
printf 'blob3' > "$VOLROOT/data/artifacts/space-b/blob-3"
export FAKE_VOLUME="rakazo_appdata"
export FAKE_VOLUME_DIR="$VOLROOT/data"
export FAKE_ARTIFACT_ROWS=1
export FAKE_ARTIFACT_KEYS="space-b/blob-3"
export FAKE_COMPOSE_CONTAINERS="abc123"
# The mount must carry its destination: the resolver only accepts a mount
# that is AT /data, so a fake without one would (rightly) be ignored.
export FAKE_INSPECT_MOUNT="volume\trakazo_appdata\t/data"
# A web-assets volume that is mounted elsewhere. A resolver that took the
# first volume mount would archive this instead of the data.
export FAKE_INSPECT_OTHER_MOUNTS="volume\trakazo_webassets\t/app/public"
# No $ROOT/data: the only source is the named volume.
if out="$(run_backup "$REPO" test2 2>&1)"; then
  pass "compose volume backup succeeds"
else
  fail "compose volume backup succeeds: $out"
fi
if tar -tzf "$REPO/backups/test2/homes.tgz" 2>/dev/null | grep -q 'data/artifacts/space-b/blob-3'; then
  pass "compose volume archive contains the artifact blob"
else
  fail "compose volume archive contains the artifact blob"
fi
grep -q 'data-source-kind: volume' "$REPO/backups/test2/MANIFEST" \
  && pass "manifest records the volume as the data source" \
  || fail "manifest records the volume as the data source"

# ------------------------------------- 3. no data source: must fail loudly
REPO="$WORK/nodata"
setup_repo "$REPO"
unset FAKE_VOLUME || true
unset FAKE_VOLUME_DIR || true
unset FAKE_COMPOSE_CONTAINERS || true
unset FAKE_INSPECT_MOUNT || true
export FAKE_ARTIFACT_ROWS=0
export FAKE_ARTIFACT_KEYS=""
if out="$(run_backup "$REPO" test3 2>&1)"; then
  fail "backup without any data source must fail (it exited 0)"
else
  pass "backup without any data source fails (exit non-zero)"
fi
case "$out" in
  *"no data directory found"*) pass "failure names the missing data source" ;;
  *) fail "failure names the missing data source: $out" ;;
esac
[[ ! -s "$REPO/backups/test3/homes.tgz" ]] \
  && pass "no empty archive is left behind" \
  || fail "no empty archive is left behind"

# --------------------------------------- 4. the explicit escape hatch works
if out="$(RAKAZO_BACKUP_SKIP_HOMES=1 run_backup "$REPO" test4 2>&1)"; then
  pass "RAKAZO_BACKUP_SKIP_HOMES=1 succeeds"
else
  fail "RAKAZO_BACKUP_SKIP_HOMES=1 succeeds: $out"
fi
grep -q 'data-skipped: yes' "$REPO/backups/test4/MANIFEST" \
  && pass "manifest says the data was skipped" \
  || fail "manifest says the data was skipped"
grep -q 'NO artifact blob is recoverable' "$REPO/backups/test4/MANIFEST" \
  && pass "manifest warns that no blob is recoverable" \
  || fail "manifest warns that no blob is recoverable"

# -------------------------------- 5. an existing backup is reused, not refused
# The upstream contract: a backup directory may already exist. The run
# replaces the artifacts in it and keeps them private. A FAILED run must
# leave the previous artifacts untouched, because the archive is written to a
# temporary file and renamed only when it is complete.
REPO="$WORK/reuse"
setup_repo "$REPO"
mkdir -p "$REPO/data/artifacts/space-c"
printf 'blob4' > "$REPO/data/artifacts/space-c/blob-4"
export FAKE_ARTIFACT_ROWS=1
export FAKE_ARTIFACT_KEYS="space-c/blob-4"
run_backup "$REPO" test5 >/dev/null 2>&1 || true
if out="$(run_backup "$REPO" test5 2>&1)"; then
  pass "a second run on the same stamp reuses the directory"
else
  fail "a second run on the same stamp must succeed: $out"
fi
if [[ -f "$REPO/backups/test5/MANIFEST" ]]; then
  pass "the reused directory holds the new manifest"
else
  fail "the reused directory has no manifest"
fi
# A failed archive must not replace the previous one.
printf 'previous archive' > "$REPO/backups/test5/homes.tgz"
export FAIL_TAR=1
run_backup "$REPO" test5 >/dev/null 2>&1 || true
unset FAIL_TAR
if [[ "$(cat "$REPO/backups/test5/homes.tgz" 2>/dev/null)" == "previous archive" ]]; then
  pass "a failed archive leaves the previous one in place"
else
  fail "a failed archive replaced the previous one"
fi

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "backup.sh self-test: all checks passed"
else
  echo "backup.sh self-test: $FAILURES check(s) FAILED"
fi
exit "$FAILURES"
