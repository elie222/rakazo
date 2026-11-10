#!/usr/bin/env bash
# Self-test for scripts/restore.sh.
#
# It fakes the two layouts a restore has to support and asserts the behaviour
# that matters:
#   1. a source checkout (data in $ROOT/data) restores into that directory and
#      keeps the previous tree in a rollback directory;
#   2. a compose deployment (data in a named volume mounted at /data) restores
#      INTO THE VOLUME and does not create a host $ROOT/data that the
#      containers never read;
#   3. NO data source at all FAILS LOUDLY and writes nothing;
#   4. an archive containing a path outside data/ is rejected.
#
# The fakes are shell stubs on PATH: `docker` is replaced, so no daemon and no
# database are needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/restore.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
pass() { printf 'ok   - %s\n' "$*"; }
fail() { printf 'FAIL - %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

[[ -f "$SCRIPT" ]] || { echo "missing $SCRIPT" >&2; exit 1; }

# ---------------------------------------------------------------- stubs
STUB="$WORK/stub"
mkdir -p "$STUB/bin"

cat > "$STUB/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -uo pipefail
log() { printf '%s\n' "$*" >> "${FAKE_DOCKER_STATE:-/dev/null}/docker.log" 2>/dev/null || true; }
log "docker $*"

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
            *pg_isready*) exit 0 ;;
            *psql*) cat > /dev/null 2>&1 || true; exit 0 ;;
          esac
        fi
        exit 0
      fi
    done
    if [[ "$*" == *"ps -q"* ]]; then
      [[ -n "${FAKE_COMPOSE_CONTAINERS:-}" ]] && printf '%s\n' "$FAKE_COMPOSE_CONTAINERS"
      exit 0
    fi
    exit 0
    ;;
  volume)
    name="${3-}"
    if [[ -n "${FAKE_VOLUME:-}" && "$name" == "${FAKE_VOLUME}" ]]; then exit 0; fi
    exit 1
    ;;
  run)
    shift
    vol=""; out=""; src=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -v)
          spec="$2"; shift 2
          v_src="${spec%%:*}"; v_dst="${spec#*:}"; v_dst="${v_dst%%:*}"
          case "$v_dst" in
            /data) vol="$v_src" ;;
            /out) out="$v_src" ;;
            /src) src="$v_src" ;;
          esac
          continue
          ;;
        *) shift ;;
      esac
    done
    log "run vol=$vol out=$out src=$src"
    hostdir="$(volume_dir "$vol")"
    [[ -n "$hostdir" ]] || exit 0
    if [[ -n "$out" ]]; then
      # Emulate: tar -czf /out/data-previous.tgz -C /data .
      mkdir -p "$out"
      ( cd "$hostdir" && tar -czf "$out/data-previous.tgz" . 2>/dev/null || true )
      exit 0
    fi
    if [[ -n "$src" && -d "$src" ]]; then
      # Emulate: cp -a /src/. /data/ then drop entries the backup did not have.
      cp -a "$src/." "$hostdir/" 2>/dev/null || true
      for entry in "$hostdir"/* "$hostdir"/.[!.]*; do
        [[ -e "$entry" ]] || continue
        name="$(basename "$entry")"
        [[ -e "$src/$name" ]] || rm -rf "$entry"
      done
      exit 0
    fi
    exit 0
    ;;
  inspect)
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

# A fake repo: the scripts, an empty compose file, and a data directory.
make_repo() {
  local repo="$1"
  mkdir -p "$repo/scripts/lib" "$repo/infra/compose"
  cp "$ROOT/scripts/restore.sh" "$repo/scripts/restore.sh"
  cp "$ROOT/scripts/lib/data-source.sh" "$repo/scripts/lib/data-source.sh"
  : > "$repo/infra/compose/docker-compose.yml"
}

# A backup set whose homes.tgz holds data/<name>.
make_backup() {
  local dir="$1"; shift
  mkdir -p "$dir"
  printf 'SELECT 1;\n' > "$dir/rakazo.sql"
  local stage="$WORK/stage.$$"
  rm -rf "$stage"; mkdir -p "$stage/data"
  for f in "$@"; do printf 'restored %s\n' "$f" > "$stage/data/$f"; done
  tar -czf "$dir/homes.tgz" -C "$stage" data
  rm -rf "$stage"
}

export PATH="$STUB/bin:$PATH"
export FAKE_DOCKER_STATE="$WORK"

# ------------------------------------------------- 1. source checkout layout
REPO1="$WORK/repo1"
make_repo "$REPO1"
mkdir -p "$REPO1/data"
printf 'old content\n' > "$REPO1/data/old.txt"
mkdir -p "$REPO1/data/sub"
printf 'old nested\n' > "$REPO1/data/sub/nested.txt"
BK1="$WORK/bk1"
make_backup "$BK1" new.txt
if "$REPO1/scripts/restore.sh" "$BK1" > "$WORK/out1" 2>&1; then
  if [[ -f "$REPO1/data/new.txt" ]]; then
    pass "dir layout: restored file is in \$ROOT/data"
  else
    fail "dir layout: restored file missing from \$ROOT/data"
  fi
  if [[ ! -e "$REPO1/data/old.txt" ]]; then
    pass "dir layout: previous tree replaced, not merged"
  else
    fail "dir layout: previous tree still present"
  fi
  if compgen -G "$REPO1"/data.rollback.* > /dev/null; then
    roll="$(compgen -G "$REPO1"/data.rollback.* | head -1)"
    if [[ -f "$roll/data/old.txt" ]]; then
      pass "dir layout: previous tree preserved in the rollback directory"
    else
      fail "dir layout: rollback directory does not hold the previous tree"
    fi
  else
    fail "dir layout: no rollback directory was created"
  fi
else
  fail "dir layout: restore.sh exited non-zero: $(tail -2 "$WORK/out1")"
fi

# -------------------------------------------------- 2. compose volume layout
REPO2="$WORK/repo2"
make_repo "$REPO2"
VOLDIR="$WORK/vol2/data"
mkdir -p "$VOLDIR"
printf 'old volume content\n' > "$VOLDIR/old.txt"
BK2="$WORK/bk2"
make_backup "$BK2" fresh.txt
export FAKE_VOLUME="rakazo_appdata"
export FAKE_VOLUME_DIR="$VOLDIR"
export FAKE_COMPOSE_CONTAINERS="api-1"
export FAKE_INSPECT_MOUNT="volume\trakazo_appdata\t/data"
export FAKE_INSPECT_OTHER_MOUNTS="volume\trakazo_webassets\t/app/public"
if "$REPO2/scripts/restore.sh" "$BK2" > "$WORK/out2" 2>&1; then
  if [[ -f "$VOLDIR/fresh.txt" ]]; then
    pass "volume layout: restored file is in the volume"
  else
    fail "volume layout: restored file missing from the volume"
  fi
  if [[ ! -e "$VOLDIR/old.txt" ]]; then
    pass "volume layout: stale volume content removed"
  else
    fail "volume layout: stale volume content still present"
  fi
  if [[ ! -e "$REPO2/data" ]]; then
    pass "volume layout: no host \$ROOT/data was created"
  else
    fail "volume layout: a host \$ROOT/data was created and the containers ignore it"
  fi
  if compgen -G "$REPO2"/data.rollback.* > /dev/null; then
    roll="$(compgen -G "$REPO2"/data.rollback.* | head -1)"
    if [[ -f "$roll/data-previous.tgz" ]]; then
      pass "volume layout: previous volume contents archived to the host"
    else
      fail "volume layout: rollback archive missing"
    fi
  else
    fail "volume layout: no rollback directory was created"
  fi
else
  fail "volume layout: restore.sh exited non-zero: $(tail -2 "$WORK/out2")"
fi

# ------------------------------------------------------ 3. no data source
REPO3="$WORK/repo3"
make_repo "$REPO3"
BK3="$WORK/bk3"
make_backup "$BK3" anything.txt
unset FAKE_VOLUME FAKE_VOLUME_DIR FAKE_COMPOSE_CONTAINERS FAKE_INSPECT_MOUNT FAKE_INSPECT_OTHER_MOUNTS
export FAKE_VOLUME="some_other_volume"
export FAKE_COMPOSE_CONTAINERS=""
export FAKE_INSPECT_MOUNT=""
if "$REPO3/scripts/restore.sh" "$BK3" > "$WORK/out3" 2>&1; then
  fail "no data source: restore.sh should have failed loudly"
else
  if grep -qi "no data source" "$WORK/out3"; then
    pass "no data source: restore fails loudly and says why"
  else
    fail "no data source: restore failed but without a clear reason"
  fi
  if [[ ! -e "$REPO3/data" ]]; then
    pass "no data source: nothing was written"
  else
    fail "no data source: a \$ROOT/data directory was created anyway"
  fi
fi
unset FAKE_VOLUME

# ------------------------------------------- 4. archive outside data/
REPO4="$WORK/repo4"
make_repo "$REPO4"
mkdir -p "$REPO4/data"
BK4="$WORK/bk4"
mkdir -p "$BK4"
printf 'SELECT 1;\n' > "$BK4/rakazo.sql"
stage="$WORK/stage4"
mkdir -p "$stage/evil"
printf 'x\n' > "$stage/evil/file.txt"
tar -czf "$BK4/homes.tgz" -C "$stage" evil
if "$REPO4/scripts/restore.sh" "$BK4" > "$WORK/out4" 2>&1; then
  fail "archive outside data: restore.sh should have rejected the archive"
else
  pass "archive outside data: restore.sh rejects the archive"
fi

printf '\n%s\n' "----------------------------------------"
if (( FAILURES == 0 )); then
  printf 'all restore tests passed\n'
  exit 0
fi
printf '%d restore test(s) failed\n' "$FAILURES"
exit 1
