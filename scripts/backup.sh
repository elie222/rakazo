#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="${1-$(date +%Y%m%d-%H%M%S)}"
case "$STAMP" in
  ""|"."|".."|*/*) echo "backup stamp must be a single nonempty path component" >&2; exit 1 ;;
esac
OUT="${ROOT}/backups/${STAMP}"
compose=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
# Compose resolves its default env file relative to the compose file, not the
# repo [redacted]; point it at the [redacted] .env when one exists (vars may also come
# from the environment, so its absence is not an error).
if [[ -f "$ROOT/.env" ]]; then compose=(docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose/docker-compose.yml"); fi
[[ ! -L "$ROOT/backups" && ! -L "$OUT" ]] || { echo "backup directory must not be a symlink" >&2; exit 1; }

# ---------------------------------------------------------------- WHY
# The data directory holds the artifact blobs: the files behind every chat
# attachment, stored under data/artifacts/<spaceId>/<storageKey> (see
# apps/api/src/artifacts.ts and packages/adapters/src/artifacts.ts). The
# Postgres rows in the `artifacts` table only point at those files.
#
# This script used to write an EMPTY homes.tgz whenever $ROOT/data did not
# exist, which is exactly the case for a compose deployment that keeps the
# data in a named volume mounted at /data. It reported success. A backup taken
# that way was useless: on 2026-11-05 a restore from such a set re-created the
# `artifacts` ROWS in Postgres with no matching BLOBS on disk, and every
# attachment created before 2026-11-06 became permanently unrecoverable.
#
# So a backup that cannot archive the data directory now FAILS LOUDLY. The
# only way to accept a data-less backup is the explicit escape hatch
# RAKAZO_BACKUP_SKIP_HOMES=1, and the MANIFEST then says the data was skipped.

# ---------------------------------------------------------------- options
SKIP_HOMES="${RAKAZO_BACKUP_SKIP_HOMES:-0}"
# Explicit data source: a host directory or a docker volume name. When set it
# wins over detection.
DATA_SOURCE="${RAKAZO_BACKUP_DATA_SOURCE:-}"
HELPER_IMAGE="${RAKAZO_BACKUP_HELPER_IMAGE:-alpine:latest}"
COMPOSE_PROJECT="${RAKAZO_COMPOSE_PROJECT:-}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { printf 'backup failed: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------- data source lookup
# The resolver lives in scripts/lib/data-source.sh so that backup.sh and
# restore.sh always agree on where the data is. Only the mount AT /data is the
# data directory: any other volume on the container (web assets, a database, a
# cache) is not, and picking one of those would archive the wrong thing and
# report success.
# shellcheck source=scripts/lib/data-source.sh
source "$ROOT/scripts/lib/data-source.sh"

# ---------------------------------------------------------------- preflight
# A backup directory may already exist: the artifacts in it are replaced by
# this run, and the previous ones survive a failed run because the archive is
# written to a temporary file and renamed only after it is complete.
mkdir -p "$OUT"
chmod 700 "$ROOT/backups" "$OUT"
for artifact in "$OUT/rakazo.sql" "$OUT/rakazo.dump" "$OUT/homes.tgz" "$OUT/MANIFEST"; do
  [[ ! -L "$artifact" ]] || { echo "backup artifact must not be a symlink" >&2; exit 1; }
  if [[ -e "$artifact" ]]; then
    [[ -f "$artifact" ]] || { echo "backup artifact is not a file" >&2; exit 1; }
    chmod 600 "$artifact"
  fi
done

# ------------------------------------------------------------- 1. pg dump
# The plain SQL dump keeps restore.sh working; the custom-format dump is the
# one that can be checked with pg_restore --list, which is what proves the
# dump is restorable instead of merely present.
log "dumping the database"
# The dumps are written to a temporary file and renamed into place, so a
# failed dump leaves the previous backup untouched instead of truncating it.
"${compose[@]}" exec -T postgres pg_dump -U rakazo rakazo > "$OUT/.rakazo.sql.tmp"
[[ -s "$OUT/.rakazo.sql.tmp" ]] || die "the SQL dump is empty"
mv -f "$OUT/.rakazo.sql.tmp" "$OUT/rakazo.sql"
"${compose[@]}" exec -T postgres pg_dump -U rakazo -Fc rakazo > "$OUT/.rakazo.dump.tmp"
[[ -s "$OUT/.rakazo.dump.tmp" ]] || die "the custom-format dump is empty"
mv -f "$OUT/.rakazo.dump.tmp" "$OUT/rakazo.dump"
chmod 600 "$OUT/rakazo.sql" "$OUT/rakazo.dump"

# --------------------------------------------------- 2. archive the data dir
SKIPPED_DATA=0
SRC_KIND=""
SRC_PATH=""
if [[ "$SKIP_HOMES" == "1" ]]; then
  SKIPPED_DATA=1
  log "RAKAZO_BACKUP_SKIP_HOMES=1: the data directory is NOT archived"
  tar -czf "$OUT/homes.tgz" --files-from /dev/null
else
  resolved="$(resolve_data_source)"
  [[ -n "$resolved" ]] || die "no data directory found: \$ROOT/data does not exist and no running container exposes a /data volume. Set RAKAZO_BACKUP_DATA_SOURCE to the directory or docker volume holding the data, or set RAKAZO_BACKUP_SKIP_HOMES=1 to accept a backup without the artifact blobs (NOT recommended)"
  SRC_KIND="${resolved%% *}"
  SRC_PATH="${resolved#* }"
  log "archiving the data directory ($SRC_KIND $SRC_PATH) into homes.tgz"
  if [[ "$SRC_KIND" == "dir" ]]; then
    # A host directory: tar it directly, keeping the "data" prefix that
    # restore.sh expects inside the archive.
    [[ ! -L "$SRC_PATH" && -d "$SRC_PATH" ]] || die "data must be a directory, not a symlink"
    parent="$(cd "$SRC_PATH/.." && pwd)"
    base="$(basename "$SRC_PATH")"
    # Archive to a temporary file and rename it into place, so a failed tar
    # leaves the previous archive in the backup directory untouched.
    tar -czf "$OUT/.homes.tgz.tmp" -C "$parent" "$base"       || die "archiving the data directory failed"
    mv -f "$OUT/.homes.tgz.tmp" "$OUT/homes.tgz"
  else
    # A named volume: read it through a throwaway container so no host path
    # is needed and the volume is never modified.
    docker run --rm \
      -v "${SRC_PATH}:/data:ro" \
      -v "${OUT}:/out" \
      "$HELPER_IMAGE" \
      tar -czf /out/.homes.tgz.tmp -C / data \
      || die "archiving the docker volume '$SRC_PATH' failed"
    mv -f "$OUT/.homes.tgz.tmp" "$OUT/homes.tgz"
  fi
  [[ -s "$OUT/homes.tgz" ]] || die "the data archive is empty"
fi
chmod 600 "$OUT/homes.tgz"

# ------------------------------------------------------------ 3. VERIFY
# A backup is only worth keeping if it can be restored, so check both halves
# before declaring success and name the check that failed when one does.
log "verifying the backup"

# 3a. The dump must be non-empty and readable by pg_restore.
dump_toc="$(mktemp)"
trap 'rm -f "$dump_toc"' EXIT
if ! "${compose[@]}" exec -T postgres sh -c \
  'cat > /tmp/rakazo_verify.dump && pg_restore --list /tmp/rakazo_verify.dump && rm -f /tmp/rakazo_verify.dump' \
  < "$OUT/rakazo.dump" > "$dump_toc"; then
  die "the database dump did not pass pg_restore --list"
fi
[[ -s "$dump_toc" ]] || die "pg_restore --list produced no output: the dump is not a valid archive"

# 3b. The archive must contain the artifact blobs, and their count must equal
#     the count on disk. This is the check the old script could not make,
#     because it never archived anything.
ARCHIVE_BLOBS=0
DISK_BLOBS=0
if [[ "$SKIPPED_DATA" != "1" ]]; then
  ARCHIVE_BLOBS="$( { tar -tzf "$OUT/homes.tgz" | grep -E '^data/artifacts/[^/]+/[^/]+$' || true; } | wc -l | tr -d '[:space:]')"
  [[ "$ARCHIVE_BLOBS" =~ ^[0-9]+$ ]] || die "could not count the artifact blobs inside the archive"
  if [[ "$SRC_KIND" == "dir" ]]; then
    # A deployment with no attachments yet has no artifacts directory, and find
    # exits non-zero on a missing path. Under pipefail that would abort an
    # otherwise good backup, so the count is taken from a tolerant pipeline.
    DISK_BLOBS="$( { find "$SRC_PATH/artifacts" -type f 2>/dev/null || true; } | wc -l | tr -d '[:space:]')"
  else
    DISK_BLOBS="$(docker run --rm -v "${SRC_PATH}:/data:ro" "$HELPER_IMAGE" \
      sh -c 'find /data/artifacts -type f 2>/dev/null || true; ' | tr -d '[:space:]')"
  fi
  [[ "$DISK_BLOBS" =~ ^[0-9]+$ ]] || die "could not count the artifact blobs on disk"
  if [[ "$ARCHIVE_BLOBS" != "$DISK_BLOBS" ]]; then
    die "artifact blob count mismatch: archive=$ARCHIVE_BLOBS on-disk=$DISK_BLOBS"
  fi
  log "verified: $ARCHIVE_BLOBS artifact blobs in the archive == $DISK_BLOBS on disk"
fi

# ------------------------------------------------------------- 4. MANIFEST
ART_ROWS=0
MISSING_BLOBS=""
if "${compose[@]}" exec -T postgres psql -U rakazo -d rakazo -tAc \
  'select count(*) from artifacts' > "$OUT/.artifact-rows" 2>/dev/null; then
  ART_ROWS="$(awk 'NF {print $1; exit}' "$OUT/.artifact-rows")"
  rm -f "$OUT/.artifact-rows"
fi
if [[ "$SKIPPED_DATA" != "1" && "$ART_ROWS" =~ ^[0-9]+$ && "$ART_ROWS" -gt 0 && "$ARCHIVE_BLOBS" -lt 1 ]]; then
  die "the data archive contains ZERO artifact blobs but the database has $ART_ROWS artifact rows: the attachment files are not in this backup"
fi
if [[ "$SKIPPED_DATA" != "1" && "$ART_ROWS" =~ ^[0-9]+$ ]]; then
  # An artifact row points at its blob through artifacts/<spaceId>/<storageKey>.
  row_keys="$(mktemp)"
  archive_keys="$(mktemp)"
  "${compose[@]}" exec -T postgres psql -U rakazo -d rakazo -tAc \
    'select "spaceId" || chr(47) || "storageKey" from artifacts' 2>/dev/null \
    | awk 'NF {print $1}' | sort -u > "$row_keys" || true
  { tar -tzf "$OUT/homes.tgz" | grep -E '^data/artifacts/[^/]+/[^/]+$' || true; } \
    | sed -E 's#^data/artifacts/##' | awk 'NF {print $1}' | sort -u > "$archive_keys"
  MISSING_BLOBS="$(comm -23 "$row_keys" "$archive_keys" | wc -l | tr -d '[:space:]')"
  rm -f "$row_keys" "$archive_keys"
fi

SQL_SHA="$(sha256sum "$OUT/rakazo.sql" | awk '{print $1}')"
DUMP_SHA="$(sha256sum "$OUT/rakazo.dump" | awk '{print $1}')"
TGZ_SHA="$(sha256sum "$OUT/homes.tgz" | awk '{print $1}')"
{
  echo "# Rakazo backup manifest"
  echo "stamp: ${STAMP}"
  echo "created-at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host: $(hostname)"
  echo "data-source-kind: ${SRC_KIND:-none}"
  echo "data-source: ${SRC_PATH:-none}"
  echo "data-skipped: $([[ "$SKIPPED_DATA" == "1" ]] && echo yes || echo no)"
  echo "pg-version: $("${compose[@]}" exec -T postgres postgres --version 2>/dev/null | tr -d '\r')"
  echo "pg-dump-version: $("${compose[@]}" exec -T postgres pg_dump --version 2>/dev/null | tr -d '\r')"
  echo "sql-sha256: ${SQL_SHA}"
  echo "dump-sha256: ${DUMP_SHA}"
  echo "homes-tgz-sha256: ${TGZ_SHA}"
  echo "homes-tgz-bytes: $(stat -c %s "$OUT/homes.tgz")"
  echo "artifact-rows: ${ART_ROWS}"
  echo "artifact-blob-files-in-archive: ${ARCHIVE_BLOBS}"
  echo "artifact-blob-files-on-disk: ${DISK_BLOBS}"
  echo "artifact-rows-without-blob: ${MISSING_BLOBS:-unknown}"
  echo
  echo "## NOT RECOVERABLE FROM THIS BACKUP"
  if [[ "$SKIPPED_DATA" == "1" ]]; then
    echo "The data directory was NOT archived (RAKAZO_BACKUP_SKIP_HOMES=1)."
    echo "NO artifact blob is recoverable from this backup: restoring it re-creates"
    echo "the artifact ROWS in Postgres with no matching files on disk."
  else
    echo "${MISSING_BLOBS:-0} of ${ART_ROWS} artifact rows have no blob on disk, so no"
    echo "backup can restore their bytes. A restore of this set re-creates those"
    echo "artifact ROWS but the attachment files stay missing (the 2026-11-05"
    echo "restore failure). Rows without a blob are the ones whose"
    echo "artifacts/<spaceId>/<storageKey> file is absent from the data directory."
    echo "Everything that IS on disk (${DISK_BLOBS} blob files) is captured by"
    echo "homes.tgz, together with the rest of the data directory."
  fi
} > "$OUT/MANIFEST"
chmod 600 "$OUT/MANIFEST"

log "backup verified and written to $OUT"
echo "Backup written to $OUT"
