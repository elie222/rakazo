#!/usr/bin/env bash
# Restore or pull the Postgres image Testcontainers and CI docker runs use.
# TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX rewrites Docker Hub names by prefixing them, so
# postgres:18-alpine becomes mirror.gcr.io/postgres:18-alpine. The GCR mirror also
# serves the canonical library/ path that explicit docker run lines use; tag both.
set -euo pipefail

PREFIX="${TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX:-}"
if [[ -n "$PREFIX" ]]; then
  PRIMARY="${PREFIX}postgres:18-alpine"
  LIBRARY="${PREFIX}library/postgres:18-alpine"
else
  PRIMARY="postgres:18-alpine"
  LIBRARY="postgres:18-alpine"
fi

CACHE_DIR="${RUNNER_TEMP:-/tmp}/docker-postgres-cache"
CACHE_TAR="$CACHE_DIR/postgres-18-alpine.tar"
mkdir -p "$CACHE_DIR"

if [[ -f "$CACHE_TAR" ]]; then
  echo "Loading cached Postgres image"
  docker load -i "$CACHE_TAR"
  # Ensure both names exist after load (older caches may only have one tag).
  if [[ "$PRIMARY" != "$LIBRARY" ]] && docker image inspect "$LIBRARY" >/dev/null 2>&1; then
    docker tag "$LIBRARY" "$PRIMARY" 2>/dev/null || true
  elif [[ "$PRIMARY" != "$LIBRARY" ]] && docker image inspect "$PRIMARY" >/dev/null 2>&1; then
    docker tag "$PRIMARY" "$LIBRARY" 2>/dev/null || true
  fi
  exit 0
fi

echo "Pulling $LIBRARY"
docker pull "$LIBRARY"
if [[ "$PRIMARY" != "$LIBRARY" ]]; then
  docker tag "$LIBRARY" "$PRIMARY"
fi
if [[ "$PRIMARY" != "$LIBRARY" ]]; then
  docker save -o "$CACHE_TAR" "$LIBRARY" "$PRIMARY"
else
  docker save -o "$CACHE_TAR" "$LIBRARY"
fi
