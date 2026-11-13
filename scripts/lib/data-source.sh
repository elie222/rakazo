#!/usr/bin/env bash
# Shared data-source resolution for scripts/backup.sh and scripts/restore.sh.
#
# A deployment keeps the application data in one of two places:
#   * a source checkout binds $ROOT/data into the containers (kind "dir");
#   * a compose deployment keeps it in a named volume mounted at /data
#     (kind "volume").
#
# Both scripts have to find the same place, and they have to find it the same
# way. Only the mount AT /data is the data directory: a container can also
# carry web assets, a database or a cache, and picking one of those archives
# the wrong thing while reporting success.
#
# Prints "<kind> <path>" and returns 0, where kind is "dir" (a host
# directory) or "volume" (a docker volume name). Prints nothing and returns
# 0 when no data source can be found, so the caller decides whether that is
# fatal. Returns 2 when an explicitly configured source is invalid.
#
# Requires: ROOT, the compose array, and optionally DATA_SOURCE and
# COMPOSE_PROJECT.

_data_source_fail() {
  if declare -F die >/dev/null 2>&1; then
    die "$*"
  else
    printf 'error: %s\n' "$*" >&2
    return 2
  fi
}

resolve_data_source() {
  if [[ -n "${DATA_SOURCE:-}" ]]; then
    if [[ -d "$DATA_SOURCE" ]]; then printf 'dir %s\n' "$DATA_SOURCE"; return 0; fi
    if docker volume inspect "$DATA_SOURCE" >/dev/null 2>&1; then
      printf 'volume %s\n' "$DATA_SOURCE"
      return 0
    fi
    _data_source_fail "data source '$DATA_SOURCE' is neither a directory nor a docker volume"
    return 2
  fi
  # A source checkout binds $ROOT/data into the containers.
  if [[ -d "$ROOT/data" && ! -L "$ROOT/data" ]]; then printf 'dir %s\n' "$ROOT/data"; return 0; fi
  # A compose deployment keeps the data in a named volume mounted at /data.
  # Ask the running compose project first, then any other running container.
  local container source type destination
  local -a candidates=()
  if command -v docker >/dev/null 2>&1; then
    while IFS= read -r container; do
      [[ -n "$container" ]] && candidates+=("$container")
    done < <("${compose[@]}" ps -q 2>/dev/null || true)
    if [[ -n "${COMPOSE_PROJECT:-}" ]]; then
      while IFS= read -r container; do
        [[ -n "$container" ]] && candidates+=("$container")
      done < <(docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" 2>/dev/null || true)
    fi
    while IFS= read -r container; do
      [[ -n "$container" ]] && candidates+=("$container")
    done < <(docker ps -q --filter "label=com.docker.compose.service=api" 2>/dev/null || true)
    for container in "${candidates[@]}"; do
      while IFS=$'\t' read -r type source destination; do
        [[ -z "$source" ]] && continue
        [[ "$destination" == "/data" ]] || continue
        if [[ "$type" == "volume" ]]; then
          printf 'volume %s\n' "$source"
          return 0
        fi
        if [[ "$type" == "bind" && -d "$source" ]]; then
          printf 'dir %s\n' "$source"
          return 0
        fi
      done < <(docker inspect --format '{{range .Mounts}}{{.Type}}{{"\t"}}{{.Source}}{{"\t"}}{{.Destination}}{{"\n"}}{{end}}' "$container" 2>/dev/null || true)
    done
  fi
  return 0
}
