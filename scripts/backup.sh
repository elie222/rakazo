#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="${1-$(date +%Y%m%d-%H%M%S)}"
case "$STAMP" in
  ""|.|..|.pending|*/*) echo "invalid or reserved backup stamp" >&2; exit 1 ;;
esac
OUT="${ROOT}/backups/${STAMP}"
compose=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
# Compose resolves its default env file relative to the compose file, not the
# repo root; point it at the root .env when one exists (vars may also come
# from the environment, so its absence is not an error).
if [[ -f "$ROOT/.env" ]]; then compose=(docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose/docker-compose.yml"); fi
[[ ! -L "$ROOT/backups" && ! -L "$OUT" ]] || { echo "backup directory must not be a symlink" >&2; exit 1; }
SKIP_HOMES="${RAKAZO_BACKUP_SKIP_HOMES:-0}"
if [[ "$SKIP_HOMES" != "1" ]]; then
  # An empty archive here would silently lose every attachment and bot home on restore.
  [[ -e "$ROOT/data" || -L "$ROOT/data" ]] || {
    echo "data/ not found; set RAKAZO_BACKUP_SKIP_HOMES=1 to back up only the database" >&2
    exit 1
  }
  [[ ! -L "$ROOT/data" && -d "$ROOT/data" ]] || { echo "data must be a directory, not a symlink" >&2; exit 1; }
fi
mkdir -p "$ROOT/backups"
chmod 700 "$ROOT/backups"
PENDING="$ROOT/backups/.pending"
[[ ! -L "$PENDING" ]] || { echo "backup staging directory must not be a symlink" >&2; exit 1; }
mkdir -p "$PENDING"
STAGE="$PENDING/$STAMP"
mkdir "$STAGE" || { echo "Check for an active or interrupted backup at $STAGE" >&2; exit 1; }
cleanup() {
  local status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [[ -d "$STAGE/previous" && ! -e "$OUT" ]]; then
    mv "$STAGE/previous" "$OUT" || { echo "Previous backup preserved at $STAGE/previous" >&2; exit 1; }
  fi
  rm -rf -- "$STAGE/new"
  if [[ -d "$STAGE/previous" ]]; then
    rm -f -- "$STAGE/previous/rakazo.sql" "$STAGE/previous/homes.tgz"
    rmdir "$STAGE/previous"
  fi
  rmdir "$STAGE"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -e "$OUT" ]]; then
  [[ -d "$OUT" ]] || { echo "backup destination must be a directory" >&2; exit 1; }
  shopt -s dotglob nullglob
  for entry in "$OUT"/*; do
    case "$entry" in
      "$OUT/rakazo.sql"|"$OUT/homes.tgz") ;;
      *) echo "backup destination contains other files; use a fresh stamp" >&2; exit 1 ;;
    esac
  done
fi
for artifact in "$OUT/rakazo.sql" "$OUT/homes.tgz"; do
  [[ ! -L "$artifact" ]] || { echo "backup artifact must not be a symlink" >&2; exit 1; }
  if [[ -e "$artifact" ]]; then
    [[ -f "$artifact" ]] || { echo "backup artifact is not a file" >&2; exit 1; }
  fi
done
if [[ -d "$OUT" ]]; then
  chmod 700 "$OUT"
  for artifact in "$OUT"/{rakazo.sql,homes.tgz}; do
    if [[ -f "$artifact" ]]; then chmod 600 "$artifact"; fi
  done
fi
mkdir "$STAGE/new"
"${compose[@]}" exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$STAGE/new/rakazo.sql"
if [[ "$SKIP_HOMES" == "1" ]]; then
  tar -czf "$STAGE/new/homes.tgz" --files-from /dev/null
else
  [[ ! -L "$ROOT/data" && -d "$ROOT/data" ]] || { echo "data must be a directory, not a symlink" >&2; exit 1; }
  tar -czf "$STAGE/new/homes.tgz" -C "$ROOT" data
fi
if [[ -d "$OUT" ]]; then mv "$OUT" "$STAGE/previous"; fi
mv "$STAGE/new" "$OUT"
echo "Backup written to $OUT"
