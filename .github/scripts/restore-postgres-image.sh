#!/usr/bin/env bash
set -euo pipefail

IMAGE="${POSTGRES_IMAGE:?set by the start-postgres action}"
CACHE_DIR="${RUNNER_TEMP:-/tmp}/docker-postgres-cache"
CACHE_TAR="$CACHE_DIR/postgres.tar"
mkdir -p "$CACHE_DIR"

if [[ -f "$CACHE_TAR" ]]; then
  docker load -i "$CACHE_TAR"
else
  docker pull "$IMAGE"
  docker save -o "$CACHE_TAR" "$IMAGE"
fi

# Testcontainers asks for postgres:18-alpine under its hub prefix, so give it the image already here.
docker tag "$IMAGE" "${TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX:-}postgres:18-alpine"
